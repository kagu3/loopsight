import { describe, expect, test } from "vitest";
import { emptyModel, toGraph, upsertElements, type ElementPatch, type ModelElement } from "../src/core/index.js";
import { addElementPatches, formOf, linkProblem, linkRemoveProblem, newElementName, parseEquation, parseTable, patchOf, reconnectPatches, renamedName } from "../web/src/editing.js";

describe("編集フォームの値", () => {
  test("数字だけなら数値、それ以外は式の文字列", () => {
    expect(parseEquation(" 0.02 ")).toBe(0.02);
    expect(parseEquation("-3")).toBe(-3);
    expect(parseEquation("1e3")).toBe(1000);
    expect(parseEquation(".5")).toBe(0.5);
    expect(parseEquation("[Population]*[Birth Rate]")).toBe("[Population]*[Birth Rate]");
    expect(parseEquation("2 * 3")).toBe("2 * 3");
    // 全角の数字と記号は半角にする。[名前] の中は変えない
    expect(parseEquation("　０.０２　")).toBe(0.02);
    expect(parseEquation("［人口（千人）］＊２")).toBe("[人口（千人）]*2");
    // 全角の ASCII と空白のほかは変えない。引用符で囲んだ文字列の中も変えない
    expect(parseEquation("[面積]＊①＋２㎡")).toBe("[面積]*①+2㎡");
    expect(parseEquation("ｶﾅ＋１")).toBe("ｶﾅ+1");
    expect(parseEquation(`IfThenElse([Ａ]＞１, "全角　ＯＫ", '１２')`)).toBe(`IfThenElse([Ａ]>1, "全角　ＯＫ", '１２')`);
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

  test("名前を変えると rename_to で送り、空の名前はエラー", () => {
    const f = formOf(stock);
    expect(f.name).toBe("S");
    expect(patchOf(stock, f, { ...f, name: " 人口 " })).toEqual({ name: "S", rename_to: "人口" });
    expect(patchOf(stock, f, { ...f, name: "人口", equation: "200" })).toEqual({ name: "S", rename_to: "人口", behavior: { initial_value: 200 } });
    expect(patchOf(stock, f, { ...f, name: "S " })).toBeUndefined();
    expect(() => patchOf(stock, f, { ...f, name: " " })).toThrow(/名前が空/);
  });
});

describe("名前を変えたあとの名前", () => {
  test("変えた要素は新しい名前、ほかはそのまま。大文字と小文字は区別しない", () => {
    const renamed: [string, string][] = [["Population", "人口"]];
    expect(renamedName("Population", renamed)).toBe("人口");
    expect(renamedName("population", renamed)).toBe("人口");
    expect(renamedName("Births", renamed)).toBe("Births");
    expect(renamedName("Population", [])).toBe("Population");
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

describe("編集モードでフローの端をつなぎ替える", () => {
  const model = () => {
    const m = emptyModel("m");
    upsertElements(m, [
      { type: "STOCK", name: "在庫", behavior: { initial_value: 100 }, display: { coordinates: [400, 100] } },
      { type: "STOCK", name: "倉庫", behavior: { initial_value: 0 }, display: { coordinates: [600, 100] } },
      { type: "VARIABLE", name: "率", behavior: { value: 0.1 }, display: { coordinates: [300, 300] } },
      { type: "FLOW", name: "入荷", from: null, to: null, behavior: { value: 1 }, display: { from_coordinates: [100, 120], to_coordinates: [240, 120] } },
    ]);
    return m;
  };
  const flow = (m: ReturnType<typeof model>) => m.elements.find((e) => e.name === "入荷")!;

  test("雲の端をストックにつなぐと、その端の雲の座標を消す", () => {
    const m = model();
    const patches = reconnectPatches(m, toGraph(m), "入荷", "to", "在庫");
    expect(patches).toEqual([{ name: "入荷", to: "在庫", display: { to_coordinates: null } }]);
    upsertElements(m, patches as ElementPatch[]);
    expect(flow(m)).toMatchObject({ from: null, to: "在庫", display: { from_coordinates: [100, 120] } });
    expect(flow(m).display!.to_coordinates).toBeUndefined();
    // 図でも、雲が 1 つになり、フローがストックにつながる
    const g = toGraph(m);
    expect(g.nodes.filter((n) => n.kind === "CLOUD")).toHaveLength(1);
    expect(g.edges.find((e) => e.id.endsWith(":out") && e.element === "入荷")!.target).toBe(g.nodes.find((n) => n.element === "在庫")!.id);
  });

  test("ストックの端を何もないところで離すと、そこに雲を置いてつなぐ", () => {
    const m = model();
    upsertElements(m, reconnectPatches(m, toGraph(m), "入荷", "from", "在庫") as ElementPatch[]);
    const patches = reconnectPatches(m, toGraph(m), "入荷", "from", { x: 150.4, y: 200.6 });
    expect(patches).toEqual([{ name: "入荷", from: null, display: { from_coordinates: [150, 201] } }]);
    upsertElements(m, patches as ElementPatch[]);
    expect(flow(m)).toMatchObject({ from: null, display: { from_coordinates: [150, 201] } });
    // もとから雲なら、雲を動かすだけ
    expect(reconnectPatches(m, toGraph(m), "入荷", "to", { x: 260, y: 140 })).toEqual([{ name: "入荷", display: { to_coordinates: [260, 140] } }]);
  });

  test("左や上にはみ出す場所に雲を置くと、全体をずらしてまとめて保存する", () => {
    const m = model();
    const patches = reconnectPatches(m, toGraph(m), "入荷", "from", { x: 0, y: 120 }) as ElementPatch[];
    upsertElements(m, patches);
    const cloud = toGraph(m).nodes.find((n) => n.kind === "CLOUD" && n.cloudOf?.end === "from")!;
    expect(cloud.x).toBeGreaterThanOrEqual(20);
    // ほかの要素も同じだけずれる
    expect(m.elements.find((e) => e.name === "在庫")!.display!.coordinates![0] - flow(m).display!.from_coordinates![0]).toBe(400);
  });

  test("ストックのほか、両端を同じストックにすることはできない。同じストックにつなぎ直すなら何もしない", () => {
    const m = model();
    expect(reconnectPatches(m, toGraph(m), "入荷", "to", "率")).toMatch(/ストックにだけ/);
    expect(reconnectPatches(m, toGraph(m), "入荷", "to", "ない")).toMatch(/「ない」が見つかりません/);
    expect(reconnectPatches(m, toGraph(m), "出荷", "to", "在庫")).toMatch(/フロー「出荷」が見つかりません/);
    upsertElements(m, reconnectPatches(m, toGraph(m), "入荷", "from", "在庫") as ElementPatch[]);
    expect(reconnectPatches(m, toGraph(m), "入荷", "to", "在庫")).toMatch(/同じストック/);
    expect(reconnectPatches(m, toGraph(m), "入荷", "from", "在庫")).toEqual([]);
  });
});
