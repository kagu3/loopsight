import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ScenarioRunResult } from "../src/viewer/api.js";
import { runModel, type ModelJSON } from "../src/core/index.js";
import { changeOf, nodeValues, timeIndex, valueScenarioNames, valueScenarioRun } from "../web/src/diagramValues.js";
import { FIXTURES_DIR } from "./helpers.js";

describe("changeOf（最初の値からの変化）", () => {
  test("増えたら +、減ったら − の割合。大きさで段階を分ける", () => {
    expect(changeOf(100, 120)).toEqual({ change: "+20%", direction: "up", level: 2 });
    expect(changeOf(100, 230)).toEqual({ change: "+130%", direction: "up", level: 3 });
    expect(changeOf(100, 533)).toEqual({ change: "+433%", direction: "up", level: 4 });
    expect(changeOf(100, 95)).toEqual({ change: "−5%", direction: "down", level: 1 });
    expect(changeOf(-50, -100)).toEqual({ change: "−100%", direction: "down", level: 3 });
  });
  test("10% より小さい変化は小数を残す", () => {
    expect(changeOf(1000, 1004).change).toBe("+0.4%");
    expect(changeOf(100, 103.25).change).toBe("+3.3%");
  });
  test("最初の値が 0 なら、割合でなく差を出す", () => {
    expect(changeOf(0, 12)).toEqual({ change: "+12", direction: "up", level: 2 });
    expect(changeOf(0, -3.5)).toEqual({ change: "−3.5", direction: "down", level: 2 });
  });
  test("変わらなければ目立たせない（計算の誤差は変化と見ない）", () => {
    expect(changeOf(100, 100 + 1e-12)).toEqual({ change: "±0%", direction: "flat", level: 0 });
    expect(changeOf(0, 0)).toEqual({ change: "±0", direction: "flat", level: 0 });
  });
});

describe("timeIndex", () => {
  test("同じ時刻の行。なければいちばん近い時刻の行", () => {
    expect(timeIndex([0, 0.1, 0.2, 0.3], 0.30000000000000004)).toBe(3);
    expect(timeIndex([0, 1, 2], 1.4)).toBe(1);
    expect(timeIndex([0, 1, 2], 9)).toBe(2);
    expect(timeIndex([], 1)).toBeUndefined();
  });
});

describe("nodeValues（図の要素に出す値）", () => {
  const run = { times: [0, 1, 2, 3], series: { Stock: [100, 120, 90, 110], Flat: [5, 5, 5, 5], Zero: [0, 2, -4, 1], Empty: [null, null, null, null] } };
  test("時点を指定しなければ、要素ごとに最初の値から一番大きく離れた時点の値と、その時点", () => {
    const v = nodeValues(run);
    expect(v.get("stock")).toEqual({ value: "120", change: "+20%", direction: "up", level: 2, time: 1 });
    expect(v.get("zero")).toEqual({ value: "-4", change: "−4", direction: "down", level: 2, time: 2 });
    // 変わらない要素は時点を添えない
    expect(v.get("flat")).toEqual({ value: "5", change: "±0%", direction: "flat", level: 0, time: undefined });
    // 値のない要素は出さない
    expect(v.has("empty")).toBe(false);
  });
  test("時点（行の番号）を指定すれば、その時点の値と最初からの変化", () => {
    const v = nodeValues(run, 2);
    expect(v.get("stock")).toEqual({ value: "90", change: "−10%", direction: "down", level: 2 });
    expect(v.get("flat")?.time).toBeUndefined();
  });
  test("値の桁はグラフのツールチップと同じ丸め方", () => {
    expect(nodeValues({ times: [0, 1], series: { X: [3, 1234.5678] } }, 1).get("x")?.value).toBe("1,234.57");
  });

  test("ブルウィップのモデルでは、消費者の需要 → 小売の発注 → 卸の発注 → 工場の生産指示 の順に最大の振れが大きくなる", () => {
    const model = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "bullwhip.json"), "utf8")) as ModelJSON;
    const data = runModel(model);
    const series = Object.fromEntries([...data.columns].map(([k, vs]) => [k, vs.map((v) => (typeof v === "number" ? v : null))]));
    const v = nodeValues({ times: data.times, series });
    const chain = ["消費者の需要", "小売の発注", "卸の発注", "工場の生産指示"].map((n) => v.get(n)!);
    const pct = chain.map((c) => Number(c.change!.replace(/[+%,]/g, "").replace("−", "-")));
    expect(chain.every((c) => c.direction === "up")).toBe(true);
    expect(pct[0]).toBe(20);
    for (let i = 1; i < pct.length; i++) expect(pct[i]!).toBeGreaterThan(pct[i - 1]!);
  });
});

describe("値を出すシナリオ", () => {
  const scenarios: ScenarioRunResult[] = [
    { name: "早く直す", values: {}, series: { X: [1, 2] } },
    { name: "壊れた", values: {}, error: "エラー" },
  ];
  test("選択に並べるのは、実行できたシナリオだけ", () => {
    expect(valueScenarioNames(scenarios)).toEqual(["早く直す"]);
    expect(valueScenarioNames(undefined)).toEqual([]);
  });
  test("選んだシナリオが実行できなかった・消されたときは、なし（何も変えない実行に戻す）", () => {
    expect(valueScenarioRun(scenarios, "早く直す")?.series).toEqual({ X: [1, 2] });
    expect(valueScenarioRun(scenarios, "壊れた")).toBeUndefined();
    expect(valueScenarioRun(scenarios, "ない")).toBeUndefined();
    expect(valueScenarioRun(scenarios, undefined)).toBeUndefined();
  });
});
