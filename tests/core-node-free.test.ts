import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";

// src/core は、インストールせずブラウザだけで使える版でもそのまま動かしたい。
// そのため Node.js の組み込みモジュールとグローバル（process、Buffer など）を使わない決まりにし、ここで確かめる。
// 依存関係の解析まではせず、ソースの文字列を調べるだけにしている

const CORE_DIR = path.resolve("src/core");

/** Node.js を使ってよいファイルと、その理由 */
const NODE_ALLOWED: Record<string, string> = {
  "store.ts": "モデルを作業フォルダのファイルとして読み書きするため。ブラウザ版では別の保存先を用意する",
};

/** Node.js を使ってよいファイルを import してよいファイルと、その理由 */
const NODE_IMPORT_ALLOWED: Record<string, string> = {
  "index.ts": "MCP サーバーとビューア（Node.js で動く）向けの公開窓口のため。ブラウザ側（web/）は個々のファイルを直接 import する",
};

const WHY = "src/core はブラウザ版でもそのまま動かすため、Node.js の API を使わない決まりです。どうしても要るときは tests/core-node-free.test.ts の例外の一覧に理由と一緒に書いてください";

/** Node.js のグローバル。globalThis.process のような書き方も拾い、ほかのプロパティ（x.process など）は除く */
const NODE_GLOBALS =
  /(?:(?<![\w$.])|(?<=(?<![\w$.])(?:globalThis|global)\.))(process|Buffer|__dirname|__filename|require|module|exports|global|setImmediate|clearImmediate)(?![\w$])/g;

/** src/core の .ts ファイル（src/core からの相対パス、/ 区切り） */
function coreFiles(): string[] {
  return readdirSync(CORE_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.split(path.sep).join("/"))
    .sort();
}

/** コメントを除いたソース */
function sourceOf(file: string): string {
  return readFileSync(path.join(CORE_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** import / export ... from / import() / require() で読み込んでいるモジュール */
function importsOf(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((m) => m[1]);
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier) || builtinModules.includes(specifier.split("/")[0]);
}

/** Node.js の組み込みモジュールとグローバルを使っているところ */
function nodeUsesIn(file: string): string[] {
  const source = sourceOf(file);
  const modules = importsOf(source).filter(isNodeBuiltin).map((m) => `${file}: "${m}" を読み込んでいる`);
  const globals = [...new Set([...source.matchAll(NODE_GLOBALS)].map((m) => m[1]))].map((g) => `${file}: グローバルの ${g} を使っている`);
  return [...modules, ...globals];
}

/** src/core の中で import しているファイル（./xxx.js を xxx.ts に直したもの） */
function localImportsOf(file: string): string[] {
  return importsOf(sourceOf(file))
    .filter((m) => m.startsWith("."))
    .map((m) => path.posix.join(path.posix.dirname(file), m).replace(/\.js$/, ".ts"));
}

/** file から import をたどって届く src/core のファイル（file 自身は含まない） */
function reachableFrom(file: string): Set<string> {
  const seen = new Set<string>();
  const queue = localImportsOf(file);
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next) || next === file) continue;
    seen.add(next);
    queue.push(...localImportsOf(next));
  }
  return seen;
}

describe("src/core が Node.js に依存していない", () => {
  test("例外のファイルのほかは、Node.js の組み込みモジュールとグローバルを使っていない", () => {
    const uses = coreFiles()
      .filter((f) => !(f in NODE_ALLOWED))
      .flatMap(nodeUsesIn);
    expect(uses, WHY).toEqual([]);
  });

  test("例外のファイルのほかは、Node.js を使うファイルを import していない（間接的にも）", () => {
    const uses = coreFiles()
      .filter((f) => !(f in NODE_ALLOWED) && !(f in NODE_IMPORT_ALLOWED))
      .flatMap((f) =>
        [...reachableFrom(f)].filter((g) => g in NODE_ALLOWED).map((g) => `${f}: import をたどると ${g} に届く`),
      );
    expect(uses, WHY).toEqual([]);
  });

  test("例外の一覧が古くなっていない", () => {
    const files = coreFiles();
    // 例外のファイルが今もあり、実際に Node.js を使っている（使わなくなったら一覧から外す）
    for (const file of Object.keys(NODE_ALLOWED)) {
      expect(files).toContain(file);
      expect(nodeUsesIn(file), `${file} はもう Node.js を使っていないので、例外の一覧から外してください`).not.toEqual([]);
    }
    for (const file of Object.keys(NODE_IMPORT_ALLOWED)) {
      expect(files).toContain(file);
      expect([...reachableFrom(file)].some((g) => g in NODE_ALLOWED), `${file} はもう Node.js を使うファイルを import していないので、例外の一覧から外してください`).toBe(true);
    }
  });
});
