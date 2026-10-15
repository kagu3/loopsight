import { describe, expect, test } from "vitest";
import { emptyModel, layoutModel, upsertElements, validateModel, type ModelJSON, type Point } from "../src/core/index.js";
import { loadSample } from "./helpers.js";

type Box = { name: string; x: number; y: number; w: number; h: number };

function boxes(m: ModelJSON): Box[] {
  return m.elements
    .filter((e) => e.display?.coordinates)
    .map((e) => {
      const [x, y] = e.display!.coordinates!;
      const [w, h] = e.display!.size ?? [100, 50];
      return { name: e.name!, x, y, w, h };
    });
}

function clouds(m: ModelJSON): Point[] {
  return m.elements.flatMap((e) => [e.display?.from_coordinates, e.display?.to_coordinates].filter((p): p is Point => !!p));
}

function expectNoOverlap(m: ModelJSON) {
  const b = boxes(m);
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const [p, q] = [b[i]!, b[j]!];
      const hit = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
      expect(hit, `${p.name} と ${q.name} が重なっている`).toBe(false);
    }
    for (const [cx, cy] of clouds(m)) {
      const p = b[i]!;
      const inside = cx > p.x && cx < p.x + p.w && cy > p.y && cy < p.y + p.h;
      expect(inside, `雲 (${cx}, ${cy}) が ${p.name} の上にある`).toBe(false);
    }
  }
}

function chain(): ModelJSON {
  const m = emptyModel("chain");
  upsertElements(m, [
    { type: "STOCK", name: "C" },
    { type: "STOCK", name: "A", behavior: { initial_value: 100 } },
    { type: "STOCK", name: "B" },
    { type: "FLOW", name: "A to B", from: "A", to: "B", behavior: { value: "[A]*[k1]" } },
    { type: "FLOW", name: "B to C", from: "B", to: "C", behavior: { value: "[B]*[k2]" } },
    { type: "FLOW", name: "Inflow", to: "A", behavior: { value: "[base]" } },
    { type: "FLOW", name: "Inflow 2", to: "A", behavior: { value: 1 } },
    { type: "FLOW", name: "Loss", from: "C", behavior: { value: "[C]*0.01" } },
    { type: "VARIABLE", name: "k1", behavior: { value: 0.1 } },
    { type: "VARIABLE", name: "k2", behavior: { value: 0.2 } },
    { type: "VARIABLE", name: "base", behavior: { value: "[scale]*2" } },
    { type: "VARIABLE", name: "scale", behavior: { value: 3 } },
    { type: "VARIABLE", name: "lonely", behavior: { value: 1 } },
    { type: "CONVERTER", name: "table", behavior: { input: "TIME", data: [[0, 1], [10, 2]] } },
  ]);
  return m;
}

describe("簡易レイアウト", () => {
  test("座標のない要素すべてに、重ならないように座標を付ける", () => {
    const m = chain();
    const placed = layoutModel(m);
    expect(placed.sort()).toEqual(["A", "B", "base", "C", "k1", "k2", "lonely", "scale", "table"].sort());
    expectNoOverlap(m);
    expect(validateModel(m).ok).toBe(true);
  });

  test("ストックはフローの流れ順に左から並ぶ", () => {
    const m = chain();
    layoutModel(m);
    const x = (n: string) => m.elements.find((e) => e.name === n)!.display!.coordinates![0];
    expect(x("A")).toBeLessThan(x("B"));
    expect(x("B")).toBeLessThan(x("C"));
  });

  test("外から来るフローには雲の位置を付け、同じストックの雲はずらす", () => {
    const m = chain();
    layoutModel(m);
    const f1 = m.elements.find((e) => e.name === "Inflow")!.display!.from_coordinates!;
    const f2 = m.elements.find((e) => e.name === "Inflow 2")!.display!.from_coordinates!;
    expect(f1).not.toEqual(f2);
    expect(m.elements.find((e) => e.name === "Loss")!.display!.to_coordinates).toBeDefined();
  });

  test("変数はつながる要素の近くに置く", () => {
    const m = chain();
    layoutModel(m);
    const pos = (n: string) => m.elements.find((e) => e.name === n)!.display!.coordinates!;
    // k2 は B→C のフロー、k1 は A→B のフローにつながるので k1 のほうが左
    expect(pos("k1")[0]).toBeLessThan(pos("k2")[0]);
  });

  test("すでにある座標は動かさない", () => {
    const m = loadSample("disease");
    const before = JSON.stringify(m);
    expect(layoutModel(m)).toEqual([]);
    expect(JSON.stringify(m)).toBe(before);
  });

  test("一部だけ座標がないときは、既存の要素と重ならない場所に置く", () => {
    const m = loadSample("disease");
    upsertElements(m, [
      { type: "VARIABLE", name: "New 1", behavior: { value: "[β]*2" } },
      { type: "VARIABLE", name: "New 2", behavior: { value: "[S]" } },
      { type: "STOCK", name: "New Stock" },
    ]);
    expect(layoutModel(m).sort()).toEqual(["New 1", "New 2", "New Stock"]);
    expectNoOverlap(m);
  });

  test("大きめのモデルでも重ならない", () => {
    const m = emptyModel("big");
    const els: Parameters<typeof upsertElements>[1] = [];
    for (let i = 0; i < 12; i++) {
      els.push({ type: "STOCK", name: `S${i}`, behavior: { initial_value: 10 } });
      if (i > 0) els.push({ type: "FLOW", name: `F${i}`, from: `S${i - 1}`, to: `S${i}`, behavior: { value: `[S${i - 1}]*[r${i}]*[g]` } });
      els.push({ type: "VARIABLE", name: `r${i}`, behavior: { value: 0.1 } });
    }
    els.push({ type: "VARIABLE", name: "g", behavior: { value: 1 } });
    upsertElements(m, els);
    layoutModel(m);
    expectNoOverlap(m);
  });
});
