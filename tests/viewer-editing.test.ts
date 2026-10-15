import { describe, expect, test } from "vitest";
import type { ModelElement } from "../src/core/index.js";
import { formOf, parseEquation, parseTable, patchOf } from "../web/src/editing.js";

describe("編集フォームの値", () => {
  test("数字だけなら数値、それ以外は式の文字列", () => {
    expect(parseEquation(" 0.02 ")).toBe(0.02);
    expect(parseEquation("-3")).toBe(-3);
    expect(parseEquation("1e3")).toBe(1000);
    expect(parseEquation(".5")).toBe(0.5);
    expect(parseEquation("[Population]*[Birth Rate]")).toBe("[Population]*[Birth Rate]");
    expect(parseEquation("2 * 3")).toBe("2 * 3");
  });

  test("コンバーターの表は 1 行に「入力, 出力」", () => {
    expect(parseTable("0, 1\n10,2\n\n20\t3")).toEqual([
      [0, 1],
      [10, 2],
      [20, 3],
    ]);
    expect(() => parseTable("0, 1\nabc")).toThrow(/2 行目/);
    expect(() => parseTable("0, 1, 2")).toThrow(/1 行目/);
    expect(() => parseTable("  ")).toThrow(/空/);
  });
});

describe("送る変更の組み立て", () => {
  const stock: ModelElement = { type: "STOCK", name: "S", behavior: { initial_value: 100, units: "人" }, description: "人口" };

  test("何も変えなければ送らない", () => {
    const f = formOf(stock);
    expect(patchOf(stock, f, { ...f })).toBeUndefined();
  });

  test("変えた項目だけを送り、空にした項目は消す", () => {
    const f = formOf(stock);
    expect(patchOf(stock, f, { ...f, equation: "200", units: "", description: "" })).toEqual({
      name: "S",
      behavior: { initial_value: 200, units: null },
      description: null,
    });
    expect(patchOf(stock, f, { ...f, nonNegative: true })).toEqual({ name: "S", behavior: { non_negative: true } });
  });

  test("変数とフローの式は value、空の式はエラー", () => {
    const v: ModelElement = { type: "VARIABLE", name: "r", behavior: { value: 0.1 } };
    const f = formOf(v);
    expect(patchOf(v, f, { ...f, equation: "[S]/10" })).toEqual({ name: "r", behavior: { value: "[S]/10" } });
    expect(() => patchOf(v, f, { ...f, equation: " " })).toThrow(/式が空/);
  });

  test("コンバーターは表を送る", () => {
    const c: ModelElement = { type: "CONVERTER", name: "c", behavior: { input: "TIME", data: [[0, 1]] } };
    const f = formOf(c);
    expect(f.table).toBe("0, 1");
    expect(patchOf(c, f, { ...f, table: "0, 1\n5, 2" })).toEqual({ name: "c", behavior: { data: [[0, 1], [5, 2]] } });
  });
});
