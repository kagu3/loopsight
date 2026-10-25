import { describe, expect, test } from "vitest";
import {
  EditError,
  areasOverlap,
  checkDiagram,
  emptyModel,
  groupAreas,
  layoutModel,
  removeElements,
  runModel,
  setGroups,
  summarizeModel,
  toGraph,
  upsertElements,
  validateModel,
  type ElementPatch,
  type ModelJSON,
} from "../src/core/index.js";

/** お店側（在庫と仕入れ）とお客側（注文残と注文）の 2 つの流れのモデル */
function shop(): ModelJSON {
  const m = emptyModel("店", { time_length: 10 });
  upsertElements(m, [
    { type: "STOCK", name: "在庫", behavior: { initial_value: 100 } },
    { type: "STOCK", name: "注文残", behavior: { initial_value: 10 } },
    { type: "VARIABLE", name: "仕入れの量", behavior: { value: 5 } },
    { type: "VARIABLE", name: "注文の量", behavior: { value: 3 } },
    { type: "FLOW", name: "仕入れ", from: null, to: "在庫", behavior: { value: "[仕入れの量]" } },
    { type: "FLOW", name: "注文", from: null, to: "注文残", behavior: { value: "[注文の量]" } },
  ]);
  return m;
}

describe("グループを保存する（set_groups）", () => {
  test("名前と要素で足す。色を省くと、ほかのグループが使っていない色にする", () => {
    const m = shop();
    const r = setGroups(m, [
      { name: "お店側", elements: ["在庫", "仕入れ"] },
      { name: "お客側", elements: ["注文残"] },
    ]);
    expect(r.added).toEqual(["お店側", "お客側"]);
    expect(m.groups).toEqual([
      { name: "お店側", color: "yellow", elements: ["在庫", "仕入れ"] },
      { name: "お客側", color: "green", elements: ["注文残"] },
    ]);
  });

  test("要素の名前は要素の表記にそろえ、ない要素や使えない色はエラーにする", () => {
    const m = shop();
    setGroups(m, [{ name: "g", elements: [" 在庫 "] }]);
    expect(m.groups![0]!.elements).toEqual(["在庫"]);
    expect(() => setGroups(m, [{ name: "g", add_elements: ["在個"] }])).toThrow(EditError);
    expect(() => setGroups(m, [{ name: "g", color: "red" }])).toThrow(/yellow/);
    expect(() => setGroups(m, [{ name: "g", add_elements: ["在個"] }])).toThrow(/見つかりません/);
  });

  test("1 つの要素が属するグループは 1 つまで。ほかのグループの要素を足すと、そちらから移す", () => {
    const m = shop();
    setGroups(m, [
      { name: "A", elements: ["在庫", "注文残"] },
      { name: "B", elements: [] },
    ]);
    const r = setGroups(m, [{ name: "B", add_elements: ["注文残"] }]);
    expect(m.groups!.map((g) => g.elements)).toEqual([["在庫"], ["注文残"]]);
    expect(r.notes.join()).toMatch(/"注文残" をグループ "A" から "B" に移しました/);
  });

  test("名前を変える・色を変える・要素を外す・消す・すべて置き換える", () => {
    const m = shop();
    setGroups(m, [{ name: "A", elements: ["在庫", "仕入れ"] }]);
    setGroups(m, [{ name: "a", rename_to: "お店側", color: "teal", remove_elements: ["仕入れ"] }]);
    expect(m.groups).toEqual([{ name: "お店側", color: "teal", elements: ["在庫"] }]);
    expect(() => setGroups(m, [{ name: "B" }, { name: "b", rename_to: "お店側" }])).toThrow(/すでにあります/);
    setGroups(m, [], { remove: ["お店側"] });
    expect(m.groups).toBeUndefined();
    setGroups(m, [{ name: "X" }]);
    setGroups(m, [{ name: "Y", elements: ["注文"] }], { replace: true });
    expect(m.groups!.map((g) => g.name)).toEqual(["Y"]);
  });

  test("要素の名前を変える・消すと、グループの中身も合わせて直る", () => {
    const m = shop();
    setGroups(m, [{ name: "お店側", elements: ["在庫", "仕入れ"] }]);
    upsertElements(m, [{ name: "在庫", rename_to: "商品の在庫" }]);
    expect(m.groups![0]!.elements).toEqual(["商品の在庫", "仕入れ"]);
    const r = removeElements(m, [{ name: "仕入れ" }]);
    expect(m.groups![0]!.elements).toEqual(["商品の在庫"]);
    expect(r.notes.join()).toMatch(/グループ "お店側" から "仕入れ" を外しました/);
  });

  test("手で書き換えた groups が壊れていても、名前変更・削除・要約・set_groups は止まらない", () => {
    for (const broken of [{ x: 1 }, [null, 3, { name: "g", elements: [null, 5, "在庫"] }, { name: "h", elements: "在庫" }]]) {
      const m = shop();
      m.groups = broken as unknown as ModelJSON["groups"];
      expect(() => upsertElements(m, [{ name: "在庫", rename_to: "商品の在庫" }])).not.toThrow();
      expect(() => removeElements(m, [{ name: "注文" }])).not.toThrow();
      expect(() => summarizeModel(m)).not.toThrow();
      expect(() => checkDiagram(m)).not.toThrow();
      setGroups(m, [{ name: "新", elements: ["注文残"] }]);
      // 壊れたものは捨て、形の合うものだけを残す
      expect(m.groups!.map((g) => g.name)).toEqual(Array.isArray(broken) ? ["g", "h", "新"] : ["新"]);
      if (Array.isArray(broken)) expect(m.groups![0]!.elements).toEqual(["商品の在庫"]);
    }
  });

  test("グループがあっても、検証と実行は変わらない（シミュレーションには使わない）", () => {
    const m = shop();
    const before = runModel(m).series;
    setGroups(m, [{ name: "お店側", elements: ["在庫", "仕入れ", "仕入れの量"] }]);
    expect(validateModel(m).ok).toBe(true);
    expect(runModel(m).series).toEqual(before);
    expect(summarizeModel(m).groups).toEqual([{ name: "お店側", color: "yellow", elements: ["在庫", "仕入れ", "仕入れの量"] }]);
  });
});

describe("図のグループの囲み", () => {
  test("属する要素をまとめて囲み、要素を動かすと囲みも付いてくる", () => {
    const m = shop();
    layoutModel(m);
    setGroups(m, [{ name: "お店側", elements: ["在庫", "仕入れの量"] }]);
    const graph = toGraph(m);
    expect(graph.groups).toEqual([{ name: "お店側", color: "yellow", elements: ["在庫", "仕入れの量"] }]);
    const [area] = groupAreas(graph.nodes, graph.groups);
    for (const id of ["el:在庫", "el:仕入れの量"]) {
      const n = graph.nodes.find((x) => x.id === id)!;
      expect(area!.x).toBeLessThan(n.x);
      expect(area!.y).toBeLessThan(n.y);
      expect(area!.x + area!.width).toBeGreaterThan(n.x + n.width);
      expect(area!.y + area!.height).toBeGreaterThan(n.y + n.height);
    }
    const moved = graph.nodes.map((n) => (n.id === "el:在庫" ? { ...n, x: n.x + 500 } : n));
    const [after] = groupAreas(moved, graph.groups);
    expect(after!.x + after!.width).toBeGreaterThan(area!.x + area!.width + 400);
  });

  test("要素が図に 1 つもないグループは囲まない。ない要素や使えない色は、描くときは黙って除く", () => {
    const m = shop();
    layoutModel(m);
    m.groups = [
      { name: "空", color: "pink", elements: [] },
      { name: "手書き", color: "red", elements: ["在庫", "ない要素"] },
    ];
    const graph = toGraph(m);
    const areas = groupAreas(graph.nodes, graph.groups);
    expect(areas.map((a) => [a.name, a.color])).toEqual([["手書き", "gray"]]);
    expect(checkDiagram(m).group_issues).toEqual(
      expect.arrayContaining([expect.stringMatching(/色 "red" は使えない/), expect.stringMatching(/"ない要素" がモデルにありません/)]),
    );
  });
});

describe("図の確認（view_diagram）のグループ", () => {
  const box = (name: string, x: number, y: number): ElementPatch => ({ type: "VARIABLE", name, behavior: { value: 1 }, display: { coordinates: [x, y] } });

  test("囲みどうしの重なりと、グループに属さない要素が囲みの中に入っているところを知らせる", () => {
    const m = emptyModel("check");
    upsertElements(m, [box("A1", 100, 100), box("A2", 400, 100), box("B1", 250, 120), box("外", 250, 300), box("中", 250, 100)]);
    setGroups(m, [
      { name: "A", elements: ["A1", "A2"] },
      { name: "B", elements: ["B1"] },
    ]);
    const c = checkDiagram(m);
    expect(c.group_issues).toContain("グループ A と グループ B の囲みが重なる");
    expect(c.group_issues).toContain("中（どのグループにも属さない）が グループ A の囲みの中に入っている");
    expect(c.group_issues.join()).not.toMatch(/外/);
    expect(c.groups!.map((g) => g.name)).toEqual(["A", "B"]);
  });

  test("グループがなければ何も知らせず、groups も返さない", () => {
    const c = checkDiagram(shop());
    expect(c.group_issues).toEqual([]);
    expect(c.groups).toBeUndefined();
  });
});

describe("グループを考えた並べ方（layout_model）", () => {
  /** 流れの順に並べると、グループが交互になるストック（甲1 → 乙1 → 甲2 → 乙2）と、それぞれの変数 */
  function interleaved(): ModelJSON {
    const m = emptyModel("交互", { time_length: 5 });
    const names = ["甲1", "乙1", "甲2", "乙2"];
    upsertElements(m, [
      ...names.map((n): ElementPatch => ({ type: "STOCK", name: n, behavior: { initial_value: 10 } })),
      ...names.map((n): ElementPatch => ({ type: "VARIABLE", name: `${n}の率`, behavior: { value: 0.1 } })),
      ...names.slice(1).map((n, i): ElementPatch => ({ type: "FLOW", name: `${names[i]}→${n}`, from: names[i]!, to: n, behavior: { value: `[${names[i]}]*[${names[i]}の率]` } })),
      { type: "FLOW", name: "乙2の出", from: "乙2", to: null, behavior: { value: "[乙2]*[乙2の率]" } },
    ]);
    setGroups(m, [
      { name: "甲", elements: ["甲1", "甲2", "甲1の率", "甲2の率"] },
      { name: "乙", elements: ["乙1", "乙2", "乙1の率", "乙2の率"] },
    ]);
    return m;
  }

  test("同じグループの要素が近くに集まり、囲みどうしが重ならない", () => {
    const m = interleaved();
    layoutModel(m);
    const graph = toGraph(m);
    const areas = groupAreas(graph.nodes, graph.groups);
    expect(areas).toHaveLength(2);
    expect(areasOverlap(areas[0]!, areas[1]!)).toBe(false);
    // ストックはグループごとに続けて並ぶ
    const x = (n: string) => m.elements.find((e) => e.name === n)!.display!.coordinates![0];
    expect([x("甲1"), x("甲2"), x("乙1"), x("乙2")]).toEqual([...[x("甲1"), x("甲2"), x("乙1"), x("乙2")]].sort((a, b) => a - b));
    expect(checkDiagram(m).group_issues.filter((s) => s.includes("囲みが重なる"))).toEqual([]);
  });
});
