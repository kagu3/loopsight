import { describe, expect, test } from "vitest";
import { sameTime, withActualPoints } from "../web/src/actualPoints.js";

const rows = () => [
  { t: 0, i: 0, s0: 100 },
  { t: 1, i: 1, s0: 110 },
  { t: 2, i: 2, s0: null },
  { t: 3, i: 3, s0: 130 },
];

describe("実際のデータの点をグラフの行に入れる", () => {
  test("時刻が同じ行には、その行に入れる", () => {
    const out = withActualPoints(rows(), new Map([["a0", [{ t: 1, v: 108 }]]]), ["s0"]);
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ t: 1, i: 1, s0: 110, a0: 108 });
  });

  test("時刻が合わなければ行を足し、モデルの値は前後の行から補う", () => {
    const out = withActualPoints(rows(), new Map([["a0", [{ t: 0.5, v: 104 }, { t: 2.5, v: 1 }, { t: 5, v: 2 }, { t: -1, v: 3 }]]]), ["s0"]);
    expect(out.map((r) => r.t)).toEqual([-1, 0, 0.5, 1, 2, 2.5, 3, 5]);
    expect(out[2]).toEqual({ t: 0.5, i: null, a0: 104, s0: 105 });
    // 前後のどちらかに値がないところと、範囲の外は補わない
    expect(out[5]!.s0).toBeNull();
    expect(out[0]!.s0).toBeNull();
    expect(out[7]!.s0).toBeNull();
  });

  test("2 つの要素が同じ時刻の行を足すときは、1 行にまとめる。元の行は変えない", () => {
    const original = rows();
    const out = withActualPoints(original, new Map([["a0", [{ t: 1.5, v: 1 }]], ["a1", [{ t: 1.5, v: 2 }]]]), ["s0"]);
    expect(out.filter((r) => r.t === 1.5)).toEqual([{ t: 1.5, i: null, a0: 1, a1: 2, s0: null }]);
    expect(original).toEqual(rows());
  });

  test("刻みの小数の誤差は同じ時刻とみなす", () => {
    expect(sameTime(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameTime(0.3, 0.31)).toBe(false);
  });
});
