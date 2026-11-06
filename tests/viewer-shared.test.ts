import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";

// サーバーとデモサイトで同じになる処理（src/viewer/shared.ts）と、デモの「サーバーの代わり」（web/src/demo/）は、ブラウザの中で動く。
// そのため Node.js の組み込みモジュールとグローバル（process、Buffer など）を使わず、Node.js を使う src/core/store.ts と、
// それを読み込む src/core/index.ts も import しない（間接的にも）ことを確かめる。
// tests/core-node-free.test.ts と同じく、ソースの文字列を調べるだけにしている

/** 調べ始めるファイル（リポジトリからの相対パス）。ここから import をたどったファイルもすべて調べる */
const ENTRIES = ["src/viewer/shared.ts", "web/src/demo/store.ts", "web/src/demo/samples.ts", "web/src/api.ts"];

/** ブラウザの中で動くものが import してはいけないファイル（Node.js を使う） */
const NODE_FILES = ["src/core/store.ts", "src/core/index.ts", "src/viewer/server.ts"];

const WHY = "src/viewer/shared.ts と web/src/demo/ はデモサイト（ブラウザの中）で動くため、Node.js の API を使わない決まりです";

/** Node.js のグローバル。globalThis.process のような書き方も拾い、ほかのプロパティ（x.process など）は除く */
const NODE_GLOBALS =
  /(?:(?<![\w$.])|(?<=(?<![\w$.])(?:globalThis|global)\.))(process|Buffer|__dirname|__filename|require|module|exports|global|setImmediate|clearImmediate)(?![\w$])/g;

/** コメントを除いたソース */
function sourceOf(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/**
 * import / export ... from / import() / require() で読み込んでいるモジュール。
 * import type と export type は、ビルドで消える（ブラウザでは読み込まない）ので数えない
 */
function importsOf(source: string): string[] {
  source = source.replace(/\b(?:import|export)\s+type\s[^;]*?\bfrom\s*["'][^"']+["']/g, "");
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((m) => m[1]!);
}

const isNodeBuiltin = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier) || builtinModules.includes(specifier.split("/")[0]!);

/** 相対の import を、リポジトリからの相対パス（.ts か .tsx）に直す */
function resolveLocal(from: string, specifier: string): string {
  const base = path.posix.join(path.posix.dirname(from), specifier).replace(/\.js$/, "");
  for (const ext of [".ts", ".tsx"]) {
    try {
      readFileSync(path.resolve(base + ext));
      return base + ext;
    } catch {
      // 次の拡張子を試す
    }
  }
  return base + ".ts";
}

/** ENTRIES から import をたどって届くファイル（ENTRIES も含む） */
function reachable(): string[] {
  const seen = new Set<string>();
  const queue = [...ENTRIES];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (NODE_FILES.includes(file)) continue;
    for (const m of importsOf(sourceOf(file))) if (m.startsWith(".")) queue.push(resolveLocal(file, m));
  }
  return [...seen].sort();
}

describe("デモサイトで動く処理が Node.js に依存していない", () => {
  test("Node.js の組み込みモジュールとグローバルを使っていない", () => {
    const uses = reachable()
      .filter((f) => !NODE_FILES.includes(f))
      .flatMap((file) => {
        const source = sourceOf(file);
        const modules = importsOf(source)
          .filter(isNodeBuiltin)
          .map((m) => `${file}: "${m}" を読み込んでいる`);
        const globals = [...new Set([...source.matchAll(NODE_GLOBALS)].map((m) => m[1]))].map((g) => `${file}: グローバルの ${g} を使っている`);
        return [...modules, ...globals];
      });
    expect(uses, WHY).toEqual([]);
  });

  test("Node.js を使うファイル（src/core/store.ts など）を import していない（間接的にも）", () => {
    expect(reachable().filter((f) => NODE_FILES.includes(f)), WHY).toEqual([]);
  });

  test("調べるファイルに、共通の処理とデモの処理が入っている（たどり方が壊れていない）", () => {
    const files = reachable();
    expect(files).toContain("src/core/simulate.ts");
    expect(files).toContain("src/viewer/api.ts");
  });
});
