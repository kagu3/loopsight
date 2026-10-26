// ツールのリファレンス（docs/reference/tools.md）を、ツールの定義（src/mcp/tools.ts）から作り直す。
//
//   npm run docs
//
// MCP サーバーをメモリの上で立てて、AI が受け取るのと同じツールの一覧（tools/list の JSON Schema）を読み、Markdown にする。
// 手で書き写さないので、ツールの説明を変えたら作り直すだけでよい。作り直し忘れは tests/tools-reference.test.ts が見つける。
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TOOLS_REFERENCE_PATH = path.join(root, "docs/reference/tools.md");

/** サーバーを立てて、ツールの一覧とサーバーの説明（instructions）を読む。createServer は src か dist の同じ関数 */
export async function collectTools(createServer) {
  // ツールの一覧を読むだけなので、作業フォルダは使わない（なくてもよい）
  const server = createServer({ modelsDir: path.join(tmpdir(), "loopsight-docs") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-reference", version: "0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return { tools, instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
  }
}

// ---- Markdown にする ----

/** <svg> のように HTML のタグに見える書き方だけを逃がす（<モデル名> はそのままでも出る） */
const escapeText = (s) => String(s).replace(/<(?=[A-Za-z/!?])/g, "&lt;");

/** ツールや引数の説明。説明の中の改行（「改行（\n）で行を分けられる」など）は \n と書いて 1 行に収める */
const descText = (s) => escapeText(s).replace(/\r?\n/g, "\\n");

/** 表のセルに入れられる形にする（| を逃がす） */
const cell = (s) => descText(s).replace(/\|/g, "\\|");

const TYPE_LABEL = { string: "文字列", number: "数", integer: "整数", boolean: "true / false", null: "null" };

/** JSON Schema の型を、人が読める短い言葉にする */
function typeText(s) {
  if (!s || Object.keys(s).filter((k) => k !== "description").length === 0) return "なんでも";
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" / ");
  if (s.anyOf || s.oneOf) return (s.anyOf ?? s.oneOf).map(typeText).join(" / ");
  const types = Array.isArray(s.type) ? s.type : [s.type];
  return types.map((t) => typeOne(s, t)).join(" / ");
}

function typeOne(s, t) {
  if (t === "array") {
    // [x, y] のように、決まった数の値を並べるもの
    if (Array.isArray(s.items)) return `[${s.items.map(typeText).join(", ")}]`;
    const item = s.items ?? {};
    const inner = typeText(item);
    if (item.type === "object") return "オブジェクトの配列";
    return item.anyOf || item.enum || Array.isArray(item.type) ? `配列（中身: ${inner}）` : `${inner}の配列`;
  }
  if (t === "object") {
    if (s.properties) return "オブジェクト";
    // { キー: 値 } の形（キーは自由に決める）
    return `{ 名前: ${typeText(s.additionalProperties)} }`;
  }
  return TYPE_LABEL[t] ?? String(t);
}

/** 長さや範囲の決まり */
function limitsText(s) {
  const out = [];
  // 整数の型に付く、上限や下限がないのと同じ範囲（Number.MAX_SAFE_INTEGER）は出さない
  const big = (n) => n !== undefined && Math.abs(n) >= Number.MAX_SAFE_INTEGER;
  if (big(s.minimum) || big(s.maximum)) s = { ...s, minimum: big(s.minimum) ? undefined : s.minimum, maximum: big(s.maximum) ? undefined : s.maximum };
  if (s.minLength === 1) out.push("空にできない");
  else if (s.minLength !== undefined) out.push(`${s.minLength} 文字以上`);
  if (s.maxLength !== undefined) out.push(`${s.maxLength} 文字まで`);
  if (s.minimum !== undefined && s.maximum !== undefined) out.push(`${s.minimum}〜${s.maximum}`);
  else if (s.minimum !== undefined) out.push(`${s.minimum} 以上`);
  else if (s.maximum !== undefined) out.push(`${s.maximum} 以下`);
  if (!Array.isArray(s.items)) {
    if (s.minItems !== undefined && s.minItems > 0) out.push(`${s.minItems} 個以上`);
    if (s.maxItems !== undefined) out.push(`${s.maxItems} 個まで`);
  }
  return out.length ? `（${out.join("、")}）` : "";
}

/**
 * 既定値。スキーマに default があればそれを、なければ説明の「既定は false」「既定 200」のような書き方から取り出す
 * （ツールの既定値は処理の中で決めていて、スキーマには出ないことが多いため）。
 */
function defaultText(s) {
  if (s.default !== undefined) return `\`${JSON.stringify(s.default)}\``;
  // 「既定は」「既定値は」か「既定 」（空白）のあとだけを値とみる。「既定に戻す」「既定のまま」「既定では」などは値ではない
  const m = /既定(?:値?は\s*|\s+)([^）。、（\s][^）。、（]*)/.exec(s.description ?? "");
  if (!m) return "";
  const v = m[1].trim();
  // false や 200 のような値はコードの形で、「両方」のような言葉はそのまま出す
  return /^[\x21-\x7e]+$/.test(v) ? `\`${v}\`` : v;
}

/** 入れ子の引数も含めて、表の行（名前、型、必須、既定値、説明）にする */
function paramRows(schema, prefix = "") {
  const rows = [];
  const required = new Set(schema.required ?? []);
  for (const [name, s] of Object.entries(schema.properties ?? {})) {
    const full = prefix + name;
    rows.push([`\`${full}\``, typeText(s) + limitsText(s), required.has(name) ? "○" : "", defaultText(s), s.description ?? ""]);
    if (s.type === "object" && s.properties) rows.push(...paramRows(s, `${full}.`));
    if (s.type === "array" && s.items?.type === "object" && s.items.properties) rows.push(...paramRows(s.items, `${full}[].`));
  }
  return rows;
}

function toolSection(tool) {
  const lines = [`## ${tool.name}`, ""];
  const notes = [];
  if (tool.annotations?.readOnlyHint) notes.push("モデルを変えない");
  if (tool.annotations?.destructiveHint) notes.push("消したものは戻せない");
  lines.push(`**${escapeText(tool.title ?? tool.name)}**${notes.length ? `（${notes.join("。")}）` : ""}`, "");
  lines.push(descText(tool.description ?? ""), "");
  const rows = paramRows(tool.inputSchema ?? {});
  if (!rows.length) {
    lines.push("引数はない。", "");
    return lines;
  }
  lines.push("| 引数 | 型 | 必須 | 既定値 | 説明 |", "| --- | --- | :-: | --- | --- |");
  for (const r of rows) lines.push(`| ${r.map(cell).join(" | ")} |`);
  lines.push("");
  return lines;
}

/** サーバーの説明を Markdown にする。1 行ずつを段落か箇条書きの 1 項目にする */
function instructionsSection(instructions) {
  return instructions
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => escapeText(l))
    .join("\n\n");
}

/** ツールの一覧とサーバーの説明から、docs/reference/tools.md の中身を作る */
export function renderToolsReference({ tools, instructions }) {
  const out = [
    "# ツールのリファレンス",
    "",
    "loopsight の MCP サーバーが AI に渡しているツールの一覧。AI はこの説明を読んで、頼まれたことに合うツールを選んで呼ぶ。人が読むと、AI に何を頼めるか、どこまで細かく指定できるかがわかる。",
    "",
    "このファイルは、ツールの定義（`src/mcp/tools.ts`）から `npm run docs` で作っている。手で直さず、ツールを変えたら作り直す（作り直すのを忘れると `npm test` が落ちる）。",
    "",
    "## ツールの一覧",
    "",
    "| ツール | できること |",
    "| --- | --- |",
    ...tools.map((t) => `| [${t.name}](#${t.name}) | ${cell(t.title ?? "")} |`),
    "",
    "## AI に渡している使い方の説明",
    "",
    "サーバーにつないだときに、ツールの一覧といっしょに AI に渡している説明（そのまま載せている）。AI がどういう流れでツールを使うかがわかる。",
    "",
    instructionsSection(instructions),
    "",
    "## 引数の表の見方",
    "",
    "- `loop.elements` のように `.` でつないだ引数は、`loop` の中の `elements` を表す",
    "- `elements[].type` のように `[]` の付いた引数は、配列 `elements` の 1 つ 1 つの中の `type` を表す",
    "- 必須の ○ は、その引数（入れ子なら、それを含むものを渡したときの、その中で）を省けないことを表す",
    "- 既定値は、省いたときに使われる値。説明の「既定は …」から取り出している",
    "- `{ 名前: … }` は、キーを自由に決められるオブジェクト（要素名をキーにするものなど）",
    "",
    ...tools.flatMap(toolSection),
  ];
  return out.join("\n").replace(/\n+$/, "\n");
}

// ---- npm run docs ----

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createServer } = await import(new URL("../dist/mcp/server.js", import.meta.url).href);
  const md = renderToolsReference(await collectTools(createServer));
  mkdirSync(path.dirname(TOOLS_REFERENCE_PATH), { recursive: true });
  writeFileSync(TOOLS_REFERENCE_PATH, md);
  console.log(`作り直しました: ${path.relative(root, TOOLS_REFERENCE_PATH)}`);
}
