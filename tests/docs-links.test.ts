// 文書のリンク切れを見つける。
// リポジトリ直下と docs/ の下の Markdown にある相対リンクと画像のパスが実際にあるか、
// 見出しへのリンク（#…）の見出しがあるかを確かめる。外のサイト（http など）へのリンクは確かめない（ネットにつながらないようにする）
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(".");
/** リポジトリからの相対パス（/ 区切り） */
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** 確かめる Markdown：リポジトリ直下の *.md と、docs/ の下の *.md（サブフォルダも） */
function markdownFiles(): string[] {
  const top = readdirSync(ROOT).filter((f) => f.endsWith(".md")).map((f) => path.join(ROOT, f));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".md") ? [path.join(dir, e.name)] : [],
    );
  return [...top, ...walk(path.join(ROOT, "docs"))];
}

/** コードのブロック（``` や ~~~ で囲んだところ）を空の行にする。行の番号は変えない */
function withoutCodeBlocks(text: string): string[] {
  let fence: string | null = null;
  return text.split(/\r?\n/).map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
      return "";
    }
    if (m) {
      fence = m[1]!;
      return "";
    }
    return line;
  });
}

/** 行の中のコード（`…`）を消す */
const withoutInlineCode = (line: string) => line.replace(/(`+)[\s\S]*?\1/g, "");

/** GitHub と同じ作り方で、見出しの文字から名前（#… の部分）を作る */
function slugOf(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // リンクは文字だけにする
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** ファイルの見出しの名前の一覧。同じ名前が 2 つ目からは -1、-2 を付ける（GitHub と同じ） */
function anchorsOf(file: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of withoutCodeBlocks(readFileSync(file, "utf8"))) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slugOf(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n ? `${base}-${n}` : base);
  }
  return anchors;
}

type Link = { file: string; line: number; target: string };

/** 文書の中のリンクと画像（[…](…)、![…](…)、[名前]: … の定義） */
function linksOf(file: string, text = readFileSync(file, "utf8")): Link[] {
  const links: Link[] = [];
  withoutCodeBlocks(text).forEach((raw, i) => {
    const line = withoutInlineCode(raw);
    for (const m of line.matchAll(/!?\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ file, line: i + 1, target: m[1]! });
    }
    const def = /^ {0,3}\[(?!\^)[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/.exec(line);
    if (def) links.push({ file, line: i + 1, target: def[1]! });
  });
  return links;
}

/**
 * ファイルかフォルダがあるか。大文字と小文字も区別する（Windows と macOS のファイルは区別しないが、GitHub では区別するため）。
 * リポジトリの中のものは、区切りごとに同じ名前があるかを readdirSync で比べる
 */
function existsExactly(dest: string): boolean {
  if (!existsSync(dest)) return false;
  const parts = path.relative(ROOT, dest).split(path.sep);
  if (parts[0] === ".." || path.isAbsolute(parts[0]!)) return true;
  let dir = ROOT;
  for (const part of parts) {
    if (!part) continue;
    if (!readdirSync(dir).includes(part)) return false;
    dir = path.join(dir, part);
  }
  return true;
}

/** リンクが切れていれば、その理由を返す */
function brokenReason(link: Link): string | null {
  const { target } = link;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // http:、https:、mailto: などは確かめない
  const hash = target.indexOf("#");
  const filePart = decodeURIComponent(hash < 0 ? target : target.slice(0, hash));
  const anchor = hash < 0 ? null : decodeURIComponent(target.slice(hash + 1));
  const dest = filePart ? path.resolve(path.dirname(link.file), filePart) : link.file;
  if (!existsExactly(dest)) return `${filePart} がありません（大文字と小文字も区別します）`;
  if (anchor === null || anchor === "") return null;
  if (statSync(dest).isDirectory() || !dest.endsWith(".md")) return null;
  if (!anchorsOf(dest).has(anchor)) return `${rel(dest)} に見出し「#${anchor}」がありません`;
  return null;
}

describe("文書のリンク", () => {
  const files = markdownFiles();

  test("確かめる文書がある", () => {
    const names = files.map(rel);
    expect(names).toEqual(expect.arrayContaining(["README.md", "CONTRIBUTING.md", "CHANGELOG.md", "docs/README.md", "docs/getting-started.md", "docs/viewer.md"]));
  });

  test("相対リンク、画像のパス、見出しへのリンクが切れていない", () => {
    const broken = files.flatMap((f) =>
      linksOf(f).flatMap((l) => {
        const reason = brokenReason(l);
        return reason ? [`${rel(l.file)}:${l.line} (${l.target})：${reason}`] : [];
      }),
    );
    expect(broken, `リンクが切れています。ファイルを動かしたり名前を変えたりしたら、リンクも直してください:\n${broken.join("\n")}`).toEqual([]);
  });

  test("大文字と小文字だけ違うリンクも切れているとみなす（GitHub では開けないため）", () => {
    const file = path.join(ROOT, "README.md");
    expect(brokenReason({ file, line: 1, target: "docs/viewer.md" })).toBeNull();
    expect(brokenReason({ file, line: 1, target: "docs/VIEWER.md" })).not.toBeNull();
    expect(brokenReason({ file, line: 1, target: "Docs/viewer.md" })).not.toBeNull();
  });

  test("脚注の定義（[^1]: …）はリンクとして拾わない。リンクの定義は拾う", () => {
    const file = path.join(ROOT, "README.md");
    const targets = linksOf(file, "本文[^1]\n\n[^1]: 脚注の文\n[定義]: docs/viewer.md\n").map((l) => l.target);
    expect(targets).toEqual(["docs/viewer.md"]);
  });

  test("見出しの名前を GitHub と同じように作る", () => {
    expect(slugOf("1. Node.js を入れる")).toBe("1-nodejs-を入れる");
    expect(slugOf("線（リンク）を引く・消す")).toBe("線リンクを引く消す");
    expect(slugOf("AI と同時に変えたとき")).toBe("ai-と同時に変えたとき");
    expect(slugOf("エンジン `simulation` について（v9.0.0 で確認）")).toBe("エンジン-simulation-についてv900-で確認");
    expect(slugOf("loopsight が足した項目")).toBe("loopsight-が足した項目");
  });
});
