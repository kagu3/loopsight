import { describe, expect, test } from "vitest";
import { emptyModel, toGraph, upsertElements, type ModelElement } from "../src/core/index.js";
import { addElementPatches, formOf, linkProblem, linkRemoveProblem, newElementName, parseEquation, parseTable, patchOf } from "../web/src/editing.js";

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

describe("編集モードで要素を足す", () => {
  const model = () => {
    const m = emptyModel("m");
    upsertElements(m, [
      { type: "STOCK", name: "人口", behavior: { initial_value: 100 }, display: { coordinates: [100, 100] } },
      { type: "VARIABLE", name: "新しい変数", behavior: { value: 1 }, display: { coordinates: [300, 100] } },
    ]);
    return m;
  };

  test("仮の名前は「新しい○○」。重なれば番号を付ける（大文字と小文字は区別しない）", () => {
    const m = model();
    expect(newElementName(m, "STOCK")).toBe("新しいストック");
    expect(newElementName(m, "VARIABLE")).toBe("新しい変数 2");
    upsertElements(m, [{ type: "VARIABLE", name: "新しい変数 2", behavior: { value: 1 } }]);
    expect(newElementName(m, "VARIABLE")).toBe("新しい変数 3");
    expect(newElementName(m, "FLOW")).toBe("新しいフロー");
  });

  test("押した場所を中心に置き、値は 0。足した要素の位置だけを送る", () => {
    const m = model();
    const { name, patches } = addElementPatches(m, toGraph(m), "STOCK", { x: 400, y: 300 });
    expect(name).toBe("新しいストック");
    expect(patches[0]).toEqual({ type: "STOCK", name, behavior: { initial_value: 0 } });
    expect(patches).toHaveLength(2);
    upsertElements(m, patches);
    const box = toGraph(m).nodes.find((n) => n.element === name)!;
    // 座標は整数に丸めるので、半分までずれる
    expect(Math.abs(box.x + box.width / 2 - 400)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(box.y + box.height / 2 - 300)).toBeLessThanOrEqual(0.5);
  });

  test("フローは両端を雲にして、押した場所に弁を置く", () => {
    const m = model();
    const { name, patches } = addElementPatches(m, toGraph(m), "FLOW", { x: 400, y: 300 });
    upsertElements(m, patches);
    const flow = m.elements.find((e) => e.name === name)!;
    expect(flow).toMatchObject({ type: "FLOW", from: null, to: null, behavior: { value: 0 } });
    expect(flow.display).toEqual({ from_coordinates: [330, 300], to_coordinates: [470, 300] });
    const g = toGraph(m);
    expect(g.missingCoordinates).toBe(false);
    const valve = g.nodes.find((n) => n.kind === "VALVE" && n.element === name)!;
    expect([valve.x + valve.width / 2, valve.y + valve.height / 2]).toEqual([400, 300]);
  });

  test("左や上にはみ出す場所に置くと、全体をずらしてまとめて保存する", () => {
    const m = model();
    const { patches } = addElementPatches(m, toGraph(m), "VARIABLE", { x: 0, y: 0 });
    upsertElements(m, patches);
    const g = toGraph(m);
    expect(Math.min(...g.nodes.map((n) => n.x))).toBeGreaterThanOrEqual(20);
    expect(Math.min(...g.nodes.map((n) => n.y))).toBeGreaterThanOrEqual(20);
    // ほかの要素も同じだけずれる（並びは変わらない）
    const [a, b] = ["人口", "新しい変数"].map((n) => m.elements.find((e) => e.name === n)!.display!.coordinates!);
    expect(b![0] - a![0]).toBe(200);
  });
});

describe("編集モードでリンクを引く・消す", () => {
  const model = () => {
    const m = emptyModel("m");
    upsertElements(m, [
      { type: "STOCK", name: "人口", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "出生率", behavior: { value: 0.1 } },
      { type: "FLOW", name: "出生", to: "人口", behavior: { value: "[人口]*[出生率]" } },
    ]);
    return m;
  };

  test("引けるなら理由はない。フロー（弁）にもつなげる", () => {
    const m = model();
    expect(linkProblem(m, "人口", "出生率")).toBeUndefined();
    expect(linkProblem(m, "出生", "出生率")).toBeUndefined();
    // 逆向きは別のリンク
    expect(linkProblem(m, "出生", "人口")).toBeUndefined();
  });

  test("同じ向きのリンク、自分自身へのリンク、ない要素へは引けない（大文字と小文字は区別しない）", () => {
    const m = model();
    expect(linkProblem(m, "出生率", "出生")).toMatch(/すでにあります/);
    expect(linkProblem(m, "人口", "人口")).toMatch(/自身/);
    expect(linkProblem(m, "人口", "死亡")).toMatch(/「死亡」が見つかりません/);
    upsertElements(m, [{ type: "VARIABLE", name: "Rate", behavior: { value: 1 } }]);
    expect(linkProblem(m, "rate", "RATE")).toMatch(/自身/);
  });

  test("先の要素の式が元の要素を使っているリンクは消せない。使っていなければ消せる", () => {
    const m = model();
    expect(linkRemoveProblem(m, "出生率", "出生")).toMatch(/「出生」の式が \[出生率\] を使っている/);
    upsertElements(m, [{ type: "LINK", from: "人口", to: "出生率" }]);
    expect(linkRemoveProblem(m, "人口", "出生率")).toBeUndefined();
    // フローは自分の端のストックをリンクなしで使えるので、そのリンクは消せる
    upsertElements(m, [{ type: "LINK", from: "人口", to: "出生" }]);
    expect(linkRemoveProblem(m, "人口", "出生")).toBeUndefined();
  });

  test("コンバーターの入力元からのリンクは消せない", () => {
    const m = model();
    upsertElements(m, [
      { type: "CONVERTER", name: "効果", behavior: { input: "ELEMENT", input_element: "人口", data: [[0, 1]] } },
      { type: "LINK", from: "人口", to: "効果" },
      { type: "LINK", from: "出生率", to: "効果" },
    ]);
    expect(linkRemoveProblem(m, "人口", "効果")).toMatch(/入力が「人口」/);
    expect(linkRemoveProblem(m, "出生率", "効果")).toBeUndefined();
  });
});
