import { describe, expect, test } from "vitest";
import { draggedResultsRatio, MIN_DIAGRAM_HEIGHT, MIN_RESULTS_HEIGHT, parseExpandedPane, parseResultsRatio, RESULTS_RATIO } from "../web/src/split.js";

describe("図と下の欄の高さの分け方", () => {
  const start = { results: 300, diagram: 500, main: 1000 };

  test("境界線を上に動かすと下の欄が高くなり、下に動かすと低くなる（割合は右側の欄の高さに対して）", () => {
    expect(draggedResultsRatio(start, -100)).toBeCloseTo(0.4);
    expect(draggedResultsRatio(start, 50)).toBeCloseTo(0.25);
    expect(draggedResultsRatio(start, 0)).toBeCloseTo(0.3);
  });

  test("図も下の欄も最小の高さより低くしない", () => {
    expect(draggedResultsRatio(start, 1000) * start.main).toBe(MIN_RESULTS_HEIGHT);
    expect(draggedResultsRatio(start, -1000) * start.main).toBe(start.results + start.diagram - MIN_DIAGRAM_HEIGHT);
    // 両方の最小が入らないほど狭いときは、下の欄の最小を守る
    expect(draggedResultsRatio({ results: 220, diagram: 200, main: 500 }, -50) * 500).toBe(MIN_RESULTS_HEIGHT);
  });

  test("覚えておいた割合は、読めない値ならはじめの値にする", () => {
    expect(parseResultsRatio("0.55")).toBe(0.55);
    expect(parseResultsRatio(null)).toBe(RESULTS_RATIO);
    expect(parseResultsRatio("")).toBe(RESULTS_RATIO);
    expect(parseResultsRatio("abc")).toBe(RESULTS_RATIO);
    expect(parseResultsRatio("0")).toBe(RESULTS_RATIO);
    expect(parseResultsRatio("1.2")).toBe(RESULTS_RATIO);
  });

  test("覚えておいた広げている欄は、図か下の欄のどちらかで、読めない値なら上下に分けた形にする", () => {
    expect(parseExpandedPane("diagram")).toBe("diagram");
    expect(parseExpandedPane("results")).toBe("results");
    expect(parseExpandedPane("none")).toBeUndefined();
    expect(parseExpandedPane(null)).toBeUndefined();
    expect(parseExpandedPane("")).toBeUndefined();
    expect(parseExpandedPane("Diagram")).toBeUndefined();
  });
});
