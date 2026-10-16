import { describe, expect, test } from "vitest";
import type { RunResult, ScenarioRunResult } from "../src/viewer/api.js";
import { BASELINE_NAME, compareRuns, describeRun } from "../web/src/scenarios.js";
import { BASELINE_SCENARIO } from "../src/core/index.js";

const run: RunResult = { time_units: "years", times: [0, 1], series: { Pop: [100, 110] } };
const scenario = (name: string, extra: Partial<ScenarioRunResult> = {}): ScenarioRunResult => ({
  name,
  values: { Rate: 0.2 },
  series: { Pop: [100, 120] },
  ...extra,
});

describe("施策を重ねるグラフ", () => {
  test("「何もしない場合」を先頭に、実行できた施策を並べる", () => {
    const c = compareRuns(run, [scenario("a"), scenario("b", { series: undefined, error: "式が正しくありません" }), scenario("c")], 8);
    expect(c.runs.map((r) => [r.name, r.baseline])).toEqual([
      [BASELINE_NAME, true],
      ["a", false],
      ["c", false],
    ]);
    expect(c.runs[0]!.series).toBe(run.series);
    expect(c.failed).toEqual([{ name: "b", error: "式が正しくありません" }]);
    expect(c.omitted).toEqual([]);
  });

  test("色の数より多い施策は出さずに知らせる", () => {
    const c = compareRuns(run, [scenario("a"), scenario("b"), scenario("c")], 2);
    expect(c.runs.map((r) => r.name)).toEqual([BASELINE_NAME, "a", "b"]);
    expect(c.omitted).toEqual(["c"]);
    // サーバーが実行しなかった施策も「出していません」に入れる
    expect(compareRuns(run, [scenario("d", { series: undefined, skipped: true })], 8).omitted).toEqual(["d"]);
  });

  test("「何もしない場合」の名前はサーバーと同じ", () => {
    expect(BASELINE_NAME).toBe(BASELINE_SCENARIO);
  });

  test("凡例の説明には、施策の説明と変える値を出す", () => {
    const [base, a] = compareRuns(run, [scenario("a", { description: "速く増やす" })], 8).runs;
    expect(describeRun(base!)).toMatch(/何も変えず/);
    expect(describeRun(a!)).toBe("速く増やす\n変える値：Rate = 0.2");
  });
});
