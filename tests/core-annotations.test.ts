import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  annotationLayout,
  annotationsOf,
  checkDiagram,
  emptyModel,
  engineModel,
  findLoops,
  layoutModel,
  runModel,
  setAnnotations,
  setGroups,
  summarizeModel,
  toGraph,
  upsertElements,
  validateModel,
  type ModelJSON,
} from "../src/core/index.js";
import { addNotePatches } from "../web/src/editing.js";

/** ストック S（左上 300, 100、100×40）と、左の雲から S に入るフロー「流入」のモデル */
function model(): ModelJSON {
  const m = emptyModel("notes");
  upsertElements(m, [
    { type: "STOCK", name: "S", behavior: { initial_value: 0 }, display: { coordinates: [300, 100] } },
    { type: "FLOW", name: "流入", from: null, to: "S", behavior: { value: 1 }, display: { from_coordinates: [100, 120] } },
  ]);
  return m;
}

const population = () => JSON.parse(readFileSync("examples/population.json", "utf8")) as ModelJSON;

describe("注釈の文字の折り返し", () => {
  test("決まった幅で折り返し、改行はそのまま行を分ける", () => {
    const { size, lines } = annotationLayout("外から人が入ってくると人口は増えます。出ていく人が多いと減ります。\n二行目");
    expect(size[0]).toBe(200);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)).toBe("二行目");
    // 句読点は行の頭に来ない
    expect(lines.every((l) => !l.startsWith("。") && !l.startsWith("、"))).toBe(true);
  });

  test("英語の言葉は途中で分けない", () => {
    const { lines } = annotationLayout("Population grows when births exceed deaths", 120);
    expect(lines.join(" ")).toBe("Population grows when births exceed deaths");
    expect(lines.length).toBeGreaterThan(1);
  });

  test("幅を広げると行が減り、高さは行の数で決まる", () => {
    const narrow = annotationLayout("あいうえおかきくけこさしすせそたちつてと", 100);
    const wide = annotationLayout("あいうえおかきくけこさしすせそたちつてと", 400);
    expect(wide.lines.length).toBeLessThan(narrow.lines.length);
    expect(wide.size[1]).toBeLessThan(narrow.size[1]);
  });
});

describe("setAnnotations", () => {
  test("足す・直す・消す。id を省くと「注釈1」のように付ける", () => {
    const m = model();
    const added = setAnnotations(m, [{ text: "読み方", coordinates: [10, 10] }, { id: "メモ", text: "補足", coordinates: [500, 300], width: 150 }]);
    expect(added.added).toEqual(["注釈1", "メモ"]);
    expect(m.annotations).toEqual([
      { id: "注釈1", text: "読み方", coordinates: [10, 10] },
      { id: "メモ", text: "補足", coordinates: [500, 300], width: 150 },
    ]);

    const updated = setAnnotations(m, [{ id: "注釈1", text: "図の読み方", coordinates: [20.4, 30.6] }, { id: "メモ", width: null }]);
    expect(updated.updated).toEqual(["注釈1", "メモ"]);
    expect(m.annotations).toEqual([
      { id: "注釈1", text: "図の読み方", coordinates: [20, 31] },
      { id: "メモ", text: "補足", coordinates: [500, 300] },
    ]);

    // 消した id は、次に足すときにまた使う
    const removed = setAnnotations(m, [{ text: "新しい" , coordinates: [0, 0] }], { remove: ["注釈1"] });
    expect(removed.removed).toEqual(["注釈1"]);
    expect(annotationsOf(m).map((a) => a.id)).toEqual(["メモ", "注釈1"]);

    setAnnotations(m, [], { replace: true });
    expect(m.annotations).toBeUndefined();
  });

  test("座標を省くと、図の下に置く", () => {
    const m = model();
    setAnnotations(m, [{ text: "下に置く" }]);
    const graph = toGraph(m);
    const bottom = Math.max(...graph.nodes.filter((n) => n.kind !== "NOTE").map((n) => n.y + n.height));
    expect(m.annotations![0]!.coordinates[1]).toBeGreaterThan(bottom);
  });

  test("誤りは保存せずに理由を返す", () => {
    const m = model();
    expect(() => setAnnotations(m, [{ id: "x" }])).toThrow(/text が必要/);
    expect(() => setAnnotations(m, [{ text: "  " }])).toThrow(/text が空/);
    expect(() => setAnnotations(m, [{ text: "a", width: 10 }])).toThrow(/width/);
    expect(() => setAnnotations(m, [{ text: "a", coordinates: [1] as unknown as [number, number] }])).toThrow(/coordinates/);
    setAnnotations(m, [{ id: "メモ", text: "a", coordinates: [0, 0] }]);
    expect(() => setAnnotations(m, [], { remove: ["メモー"] })).toThrow(/もしかして "メモ"/);
  });
});

describe("注釈はシミュレーションの要素ではない", () => {
  test("注釈のあるモデルも、検証・実行・ループの探索がそのまま通り、要素の一覧に出ない", () => {
    const m = population();
    const before = { validation: validateModel(m), loops: findLoops(m) };
    setAnnotations(m, [{ text: "人口は出生で増え、死亡で減ります", coordinates: [40, 20] }]);
    expect(validateModel(m)).toEqual(before.validation);
    expect(validateModel(m).ok).toBe(true);
    expect(findLoops(m)).toEqual(before.loops);
    const run = runModel(m);
    expect(run.times.length).toBeGreaterThan(0);
    expect([...run.columns.keys()].some((k) => k.includes("注釈"))).toBe(false);
    // 要約には、要素とは別に出す
    const summary = summarizeModel(m);
    expect(summary.annotations).toEqual([{ id: "注釈1", text: "人口は出生で増え、死亡で減ります" }]);
    expect(JSON.stringify(summary.stocks)).not.toContain("注釈");
  });
});

describe("図と図の確認", () => {
  test("注釈は線のないノードになる", () => {
    const m = model();
    setAnnotations(m, [{ text: "メモ", coordinates: [600, 300] }]);
    const g = toGraph(m);
    const note = g.nodes.find((n) => n.kind === "NOTE")!;
    expect(note).toMatchObject({ note: "注釈1", label: "メモ", x: 600, y: 300, width: 200, lines: ["メモ"] });
    expect(g.edges.some((e) => e.source === note.id || e.target === note.id)).toBe(false);
  });

  test("注釈と要素の重なり、線が注釈の上を通るところを知らせ、位置を返す", () => {
    const m = model();
    setAnnotations(m, [
      { id: "重なる", text: "S に重なる", coordinates: [320, 110] },
      { id: "線の上", text: "フローの上", coordinates: [150, 110], width: 60 },
      { id: "離れた", text: "離れている", coordinates: [700, 400] },
    ]);
    const c = checkDiagram(m);
    expect(c.overlaps).toContain("S と 注釈 重なる（S に重なる）");
    expect(c.lines_through_elements.some((t) => t.includes("注釈 線の上"))).toBe(true);
    expect(c.overlaps.concat(c.lines_through_elements).some((t) => t.includes("離れた"))).toBe(false);
    expect(c.positions).toContainEqual({ name: "離れた", type: "NOTE", coordinates: [700, 400], size: annotationLayout("離れている").size });
  });

  test("layout_model（layoutModel）は注釈を動かさず、要素を注釈に重ならないところに置く", () => {
    const m = population();
    for (const el of m.elements) delete el.display;
    // 何もないモデルなら最初のストックが置かれるあたりに、注釈を置いておく
    setAnnotations(m, [{ text: "ここに注釈", coordinates: [80, 250], width: 400 }]);
    layoutModel(m);
    expect(m.annotations![0]!.coordinates).toEqual([80, 250]);
    expect(checkDiagram(m).overlaps.filter((t) => t.includes("注釈"))).toEqual([]);
  });
});

describe("ビューアで注釈を足す変更", () => {
  test("押した場所を真ん中にして、まだ使っていない id で足す", () => {
    const m = model();
    setAnnotations(m, [{ text: "前からある", coordinates: [600, 300] }]);
    const { id, elements, notes } = addNotePatches(m, toGraph(m), { x: 500, y: 200 });
    expect(id).toBe("注釈2");
    expect(elements).toEqual([]);
    const [w, h] = annotationLayout("注釈").size;
    expect(notes).toEqual([{ id: "注釈2", text: "注釈", coordinates: [Math.round(500 - w / 2), Math.round(200 - h / 2)] }]);
  });

  test("左や上にはみ出すときは、要素もほかの注釈も同じだけずらす", () => {
    const m = model();
    setAnnotations(m, [{ text: "前からある", coordinates: [600, 300] }]);
    const { elements, notes } = addNotePatches(m, toGraph(m), { x: 0, y: 200 });
    const shift = notes.find((n) => n.id === "注釈1")!.coordinates![0] - 600;
    expect(shift).toBeGreaterThan(0);
    expect(elements).toContainEqual({ name: "S", display: { coordinates: [300 + shift, 100] } });
    expect(notes.find((n) => n.id === "注釈2")!.coordinates![0]).toBe(20);
  });
});

describe("engineModel", () => {
  test("エンジンに渡すモデルから注釈を取り除く（元のモデルは変えない）", () => {
    const m = model();
    setAnnotations(m, [{ text: "メモ", coordinates: [0, 0] }]);
    expect(engineModel(m)).not.toHaveProperty("annotations");
    expect(engineModel(m).elements).toBe(m.elements);
    expect(m.annotations).toHaveLength(1);
  });
});

describe("座標のないモデルと注釈", () => {
  test("座標のないモデルに座標なしの注釈を足しても、仮の並びと layoutModel のあと、注釈は要素より下にある", () => {
    const m = population();
    for (const el of m.elements) delete el.display;
    setAnnotations(m, [{ text: "下に置く注釈" }]);
    const noteTop = m.annotations![0]!.coordinates[1];
    const elementsBottom = (nodes: { kind: string; y: number; height: number }[]) =>
      Math.max(...nodes.filter((n) => n.kind !== "NOTE").map((n) => n.y + n.height));
    expect(elementsBottom(toGraph(m).nodes)).toBeLessThan(noteTop);
    layoutModel(m);
    expect(elementsBottom(toGraph(m).nodes)).toBeLessThan(noteTop);
    expect(m.annotations![0]!.coordinates[1]).toBe(noteTop);
  });

  test("型の違う変更は、例外ではなく EditError で断る", () => {
    const m = model();
    expect(() => setAnnotations(m, [{ id: 1 as unknown as string, text: "a" }])).toThrow(/id は文字列/);
    expect(() => setAnnotations(m, [{ text: 1 as unknown as string }])).toThrow(/text は文字列/);
    expect(() => setAnnotations(m, [{ text: "a", width: "x" as unknown as number }])).toThrow(/width/);
    expect(() => setAnnotations(m, [], { remove: [1 as unknown as string] })).toThrow(/id（文字列）/);
  });

  test("英大文字が続いても、見積もった幅が実際の幅（W・M はおよそ 11.5px）より狭くならない", () => {
    const { lines, size } = annotationLayout("WWWWWWWWWW MMMMMMMMMM");
    expect(lines.length).toBe(2);
    expect(Math.max(...lines.map((l) => [...l].length)) * 11.5).toBeLessThanOrEqual(size[0] - 14);
  });
});

describe("図の印をすべて持つモデル", () => {
  test("強調・遅れの印・グループ・注釈をいっしょに持たせても、検証と実行が通り、図と図の確認が作れる", () => {
    const m = model();
    upsertElements(m, [
      { type: "VARIABLE", name: "R", behavior: { value: 2 }, display: { coordinates: [100, 300] } },
      { name: "流入", behavior: { value: "[R]" } },
    ]);
    const plain = structuredClone(m);
    upsertElements(m, [
      { name: "S", display: { emphasis: true } },
      { type: "LINK", from: "R", to: "流入", display: { delay: true } },
      { name: "流入", display: { delay: true } },
    ]);
    setGroups(m, [{ name: "まとまり", color: "green", elements: ["S", "R"] }]);
    setAnnotations(m, [{ id: "メモ", text: "R が流入を決める", coordinates: [600, 400] }]);
    expect(m.elements.find((e) => e.name === "S")!.display!.emphasis).toBe(true);
    expect(m.groups).toHaveLength(1);
    expect(m.annotations).toHaveLength(1);

    // エンジンに渡すモデルには、ループサイト独自の項目が残らない
    const engine = engineModel(m);
    expect(engine.groups).toBeUndefined();
    expect(engine.annotations).toBeUndefined();
    expect(engine.elements.some((e) => e.display && ("emphasis" in e.display || "delay" in e.display))).toBe(false);

    expect(validateModel(m).ok).toBe(true);
    expect(runModel(m).series).toEqual(runModel(plain).series);

    const graph = toGraph(m);
    expect(graph.nodes.some((n) => n.kind === "NOTE")).toBe(true);
    expect(graph.nodes.find((n) => n.element === "S")!.emphasis).toBe(true);
    expect(graph.edges.some((e) => e.delay)).toBe(true);
    expect(graph.groups).toHaveLength(1);
    const check = checkDiagram(m);
    expect(check.positions).toContainEqual(expect.objectContaining({ name: "メモ", type: "NOTE" }));
    expect(check.groups).toHaveLength(1);
  });

  test("グループの囲みの中に置いた注釈は、囲みに入っている要素として group_issues に出さない", () => {
    const m = model();
    upsertElements(m, [{ type: "VARIABLE", name: "R", behavior: { value: 2 }, display: { coordinates: [700, 100] } }]);
    setGroups(m, [{ name: "まとまり", color: "green", elements: ["S", "R"] }]);
    // S（300, 100）と R（700, 100）の間、囲みの中に置く
    setAnnotations(m, [{ id: "中のメモ", text: "まとまりの説明", coordinates: [450, 105], width: 120 }]);
    const area = checkDiagram(m).groups![0]!.area;
    expect(area.x).toBeLessThan(450);
    expect(area.x + area.width).toBeGreaterThan(570);
    expect(checkDiagram(m).group_issues.filter((t) => t.includes("注釈"))).toEqual([]);
  });
});
