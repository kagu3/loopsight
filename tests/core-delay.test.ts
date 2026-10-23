import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  delayedReferences,
  delayMarkPath,
  emptyModel,
  engineModel,
  EditError,
  findLink,
  findLoops,
  hasDelayMark,
  runModel,
  summarizeModel,
  toGraph,
  unmarkedDelays,
  upsertElements,
  type ModelJSON,
} from "../src/core/index.js";
import { FIXTURES_DIR } from "./helpers.js";

/** ブルウィップ効果のモデル（発注と出荷に Delay、需要の予測に Smooth を使う） */
function bullwhip(): ModelJSON {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, "bullwhip.json"), "utf8")) as ModelJSON;
}

/** 在庫を目標に近づける、遅れのある釣り合わせるループ（在庫 → 発注 → 入荷 → 在庫） */
function inventory(): ModelJSON {
  const m = emptyModel("inventory");
  upsertElements(m, [
    { type: "STOCK", name: "在庫", behavior: { initial_value: 100 } },
    { type: "VARIABLE", name: "発注", behavior: { value: "200 - [在庫]" } },
    { type: "FLOW", name: "入荷", from: null, to: "在庫", behavior: { value: "Delay([発注], 3, 0)" } },
  ]);
  upsertElements(m, [
    { from: "在庫", to: "発注", behavior: { polarity: "NEGATIVE" } },
    { from: "発注", to: "入荷", behavior: { polarity: "POSITIVE" } },
  ]);
  return m;
}

describe("時間をまたぐ関数に渡す参照", () => {
  test("1 つ目の引数の参照だけを返す（遅れの長さなどは含めない）", () => {
    expect(delayedReferences("Delay([発注], [遅れ], 100)")).toEqual(["発注"]);
    expect(delayedReferences("Min(Delay([A] * 2, [T]), [B])")).toEqual(["A"]);
    expect(delayedReferences("smooth([A], 3) + [B]")).toEqual(["A"]);
    expect(delayedReferences("[A].PastMax(5) + [B]")).toEqual(["A"]);
    expect(delayedReferences("Max([A], [B])")).toEqual([]);
  });

  test("1 つ目の引数の中の括弧や名前のカンマで止まらない。文字列とコメントの中は見ない", () => {
    expect(delayedReferences("Delay(Max([A, B], [C]), [T])")).toEqual(["A, B", "C"]);
    expect(delayedReferences('"Delay([X])" + [Y] # Delay([Z])')).toEqual([]);
    // 名前の中の「Delay(」は関数ではない
    expect(delayedReferences("[Delay(A)] + Max([B], 1)")).toEqual([]);
  });
});

describe("遅れの印", () => {
  test("upsert_elements の display.delay で付け外しする（false は項目を消す）", () => {
    const m = inventory();
    upsertElements(m, [
      { type: "LINK", from: "発注", to: "入荷", display: { delay: true } },
      { name: "入荷", display: { delay: true } },
    ]);
    expect(hasDelayMark(findLink(m, "発注", "入荷"))).toBe(true);
    expect(m.elements.find((e) => e.name === "入荷")?.display?.delay).toBe(true);

    upsertElements(m, [
      { from: "発注", to: "入荷", display: { delay: false } },
      { name: "入荷", display: { delay: null } },
    ]);
    expect(findLink(m, "発注", "入荷")?.display).toBeUndefined();
    expect(m.elements.find((e) => e.name === "入荷")?.display).toBeUndefined();
  });

  test("ストックや変数、true / false 以外の値は断る", () => {
    const m = inventory();
    expect(() => upsertElements(m, [{ name: "在庫", display: { delay: true } }])).toThrow(EditError);
    expect(() => upsertElements(m, [{ name: "在庫", display: { delay: true } }])).toThrow(/LINK と FLOW だけ/);
    expect(() => upsertElements(m, [{ from: "発注", to: "入荷", display: { delay: "yes" } }])).toThrow(/true（付ける）か false/);
    // 外すのは、どの要素でもよい
    expect(() => upsertElements(m, [{ name: "在庫", display: { delay: false } }])).not.toThrow();
  });

  test("印は見た目だけで、シミュレーションの結果は変わらない", () => {
    const m = inventory();
    const before = runModel(m, { targets: ["在庫"] });
    upsertElements(m, [{ from: "発注", to: "入荷", display: { delay: true } }]);
    expect(runModel(m, { targets: ["在庫"] }).series).toEqual(before.series);
  });

  test("エンジンに渡すモデルからは印を外す（ほかの display は残し、元のモデルは変えない）", () => {
    const m = inventory();
    upsertElements(m, [
      { from: "発注", to: "入荷", display: { delay: true } },
      { name: "入荷", display: { delay: true, from_coordinates: [10, 20] } },
    ]);
    const e = engineModel(m);
    expect(findLink(e, "発注", "入荷")?.display).toBeUndefined();
    expect(e.elements.find((x) => x.name === "入荷")?.display).toEqual({ from_coordinates: [10, 20] });
    expect(hasDelayMark(findLink(m, "発注", "入荷"))).toBe(true);
    // 印がなければ同じモデルを返す
    const plain = inventory();
    expect(engineModel(plain)).toBe(plain);
  });

  test("図の線に印を付ける。リンクはその線、フローは行き先の側の線", () => {
    const m = inventory();
    upsertElements(m, [
      { from: "発注", to: "入荷", display: { delay: true } },
      { name: "入荷", display: { delay: true } },
    ]);
    const g = toGraph(m);
    const delayed = g.edges.filter((e) => e.delay).map((e) => e.id);
    expect(delayed.sort()).toEqual(["link:el:発注->valve:入荷", "valve:入荷:out"]);
    expect(g.edges.find((e) => e.id === "link:el:在庫->el:発注")?.delay).toBeUndefined();
  });

  test("find_loops のつながりに delay を付ける（フローは行き先のストックへのつながりだけ）", () => {
    const m = inventory();
    upsertElements(m, [{ from: "発注", to: "入荷", display: { delay: true } }]);
    const [loop] = findLoops(m).loops;
    expect(loop).toMatchObject({ kind: "B", elements: ["在庫", "発注", "入荷"] });
    expect(loop!.steps.filter((s) => s.delay).map((s) => `${s.from} → ${s.to}`)).toEqual(["発注 → 入荷"]);

    upsertElements(m, [
      { from: "発注", to: "入荷", display: { delay: false } },
      { name: "入荷", display: { delay: true } },
    ]);
    const [again] = findLoops(m).loops;
    expect(again!.steps.filter((s) => s.delay).map((s) => `${s.from} → ${s.to}`)).toEqual(["入荷 → 在庫"]);
  });

  test("モデルの要約に印を出す", () => {
    const m = inventory();
    upsertElements(m, [
      { from: "発注", to: "入荷", display: { delay: true } },
      { name: "入荷", display: { delay: true } },
    ]);
    const s = summarizeModel(m);
    expect(s.links).toContain("発注 → 入荷 (+) ‖遅れ");
    expect(s.links).toContain("在庫 → 発注 (-)");
    expect(s.flows[0]).toMatchObject({ name: "入荷", delay_mark: true });
  });

  test("式で遅れて効くのに印のないリンクを挙げる。印を付けると消える", () => {
    const m = bullwhip();
    const unmarked = unmarkedDelays(m);
    // 出荷と生産の Delay（3 本）と、需要の予測の Smooth（3 本）
    expect(unmarked).toHaveLength(6);
    expect(unmarked).toContainEqual({ from: "小売の発注", to: "卸から小売への出荷" });
    expect(unmarked).toContainEqual({ from: "消費者の需要", to: "小売の需要予測" });
    // 遅れの長さ（2 つ目の引数）は遅れて効くわけではない
    expect(unmarked).not.toContainEqual({ from: "出荷の遅れ", to: "卸から小売への出荷" });

    upsertElements(m, unmarked.map((l) => ({ type: "LINK" as const, ...l, display: { delay: true } })));
    expect(unmarkedDelays(m)).toEqual([]);
    expect(toGraph(m).edges.filter((e) => e.delay)).toHaveLength(6);
  });

  test("印の形：線の向きに直交する 2 本の短い線", () => {
    // 右向きの線なら、縦の線が 2 本
    expect(delayMarkPath([100, 50], [10, 0], 7, 2.5)).toBe("M97.5,43 L97.5,57 M102.5,43 L102.5,57");
    // 下向きの線なら、横の線が 2 本
    expect(delayMarkPath([0, 0], [0, 4], 5, 2)).toBe("M5,-2 L-5,-2 M5,2 L-5,2");
  });
});
