import { describe, expect, test } from "vitest";
import { normalize, normalizeTogether } from "../web/src/normalize.js";

describe("グラフの正規化", () => {
  test("最小を 0、最大を 1 にする", () => {
    expect(normalize([10, 20, 30])).toEqual([0, 0.5, 1]);
    expect(normalize([-5, 5])).toEqual([0, 1]);
  });

  test("値のないところはそのまま、ずっと同じ値は真ん中に置く", () => {
    expect(normalize([null, 1000, null, 3000])).toEqual([null, 0, null, 1]);
    expect(normalize([7, 7, 7])).toEqual([0.5, 0.5, 0.5]);
    expect(normalize([null, null])).toEqual([null, null]);
  });

  test("まとめて正規化すると、系列どうしの高さの違いが残る", () => {
    expect(normalizeTogether([[10, 20], [20, 30, null]])).toEqual([[0, 0.5], [0.5, 1, null]]);
    expect(normalizeTogether([[], [5]])).toEqual([[], [0.5]]);
  });
});
