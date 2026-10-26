import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createServer } from "../src/mcp/server.js";
// @ts-expect-error 型の宣言のない .mjs（npm run docs のスクリプト）
import { TOOLS_REFERENCE_PATH, collectTools, renderToolsReference } from "../scripts/tools-reference.mjs";

describe("ツールのリファレンス（docs/reference/tools.md）", () => {
  test("いまのツールの定義から作ったものと同じ", async () => {
    const collected = await collectTools(createServer);
    const expected: string = renderToolsReference(collected);
    const actual = await readFile(TOOLS_REFERENCE_PATH, "utf8").catch(() => "");
    // 改行の違い（チェックアウトで CRLF になったときなど）は見ない
    const same = actual.replace(/\r\n/g, "\n") === expected;
    expect(same, "docs/reference/tools.md がツールの定義とずれています。npm run docs で作り直してください。").toBe(true);
  });

  test("全ツールが、引数ごと載っている", async () => {
    const { tools } = await collectTools(createServer);
    const md: string = renderToolsReference({ tools, instructions: "" });
    for (const tool of tools) {
      expect(md).toContain(`## ${tool.name}\n`);
      for (const name of Object.keys(tool.inputSchema.properties ?? {})) expect(md).toContain(`| \`${name}\` |`);
    }
    // 入れ子の引数（要素やシナリオの中の項目）も 1 行ずつ載る
    expect(md).toContain("| `elements[].behavior` |");
    expect(md).toContain("| `scenarios[].values` |");
    expect(md).toContain("| `loop.elements` |");
  });
});
