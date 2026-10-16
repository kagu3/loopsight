import { describe, expect, test } from "vitest";
import type { ModelJSON, RunResult, ScenarioRunResult } from "../src/viewer/api.js";
import {
  BASELINE_NAME,
  compareRuns,
  currentValueOf,
  describeRun,
  findScenario,
  scenarioFormOf,
  scenarioPatchOf,
  valueTargets,
  type ScenarioForm,
} from "../web/src/scenarios.js";
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

describe("施策の編集欄", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "FLOW", name: "Births", to: "Pop", behavior: { value: "[Pop]*[Rate]" } },
      { type: "CONVERTER", name: "Table", behavior: { input: "TIME", data: [[0, 1]] } },
      { type: "LINK", from: "Rate", to: "Births" },
    ],
    scenarios: [{ name: "高い", description: "速く増やす", values: { Rate: 0.2 } }, { values: { Pop: 50 } }],
  };

  test("選べる要素はストック・変数・フロー。いまの値はストックの初期値と、変数とフローの式", () => {
    expect(valueTargets(model).map((e) => e.name)).toEqual(["Pop", "Rate", "Births"]);
    expect(currentValueOf(model, "pop")).toBe("100");
    expect(currentValueOf(model, "Births")).toBe("[Pop]*[Rate]");
    expect(currentValueOf(model, "Nope")).toBeUndefined();
  });

  test("施策は名前で探す。名前のない施策はサーバーと同じく「scenario 2」と呼ぶ", () => {
    expect(findScenario(model, "高い")).toBe(model.scenarios![0]);
    expect(findScenario(model, "Scenario 2")).toBe(model.scenarios![1]);
    expect(scenarioFormOf(model.scenarios![1], "scenario 2")).toEqual({ name: "scenario 2", description: "", rows: [{ element: "Pop", value: "50" }] });
  });

  test("model を渡すと、行の要素名をモデルの表記にそろえる（手で書いた \"rate\" も選べるように）", () => {
    const form = scenarioFormOf({ name: "手書き", values: { rate: 0.3, Nope: 1 } }, "", model);
    expect(form.rows).toEqual([
      { element: "Rate", value: "0.3" },
      { element: "Nope", value: "1" },
    ]);
    // 値を変えなければ送らない。消すときは要素の表記で null を送る（サーバーが表記の違うキーも消す）
    expect(scenarioPatchOf("手書き", form, { ...form }, [])).toBeUndefined();
    expect(scenarioPatchOf("手書き", form, { ...form, rows: [form.rows[1]!] }, [])).toEqual({ name: "手書き", values: { Rate: null } });
  });

  test("施策を足すときは、名前・説明・値をそのまま送る。数字だけなら数値にする", () => {
    const empty = scenarioFormOf(undefined);
    const after: ScenarioForm = { name: " 低い ", description: "", rows: [{ element: "Rate", value: "0.05" }, { element: "Births", value: "[Pop]*0.01" }, { element: "", value: "" }] };
    expect(scenarioPatchOf(undefined, empty, after, ["高い"])).toEqual({ name: "低い", values: { Rate: 0.05, Births: "[Pop]*0.01" } });
  });

  test("施策を直すときは、変えた項目だけを送る。消した行は null、名前を変えたら rename_to", () => {
    const before = scenarioFormOf(model.scenarios![0]);
    expect(scenarioPatchOf("高い", before, { ...before }, [])).toBeUndefined();
    expect(scenarioPatchOf("高い", before, { name: "とても高い", description: "", rows: [{ element: "Pop", value: "200" }] }, ["scenario 2"])).toEqual({
      name: "高い",
      rename_to: "とても高い",
      description: null,
      values: { Pop: 200, Rate: null },
    });
    expect(scenarioPatchOf("高い", before, { ...before, rows: [{ element: "Rate", value: "0.3" }] }, [])).toEqual({ name: "高い", values: { Rate: 0.3 } });
  });

  test("名前が空・「何もしない場合」・ほかの施策と同じ名前、同じ要素が 2 行、値が空の行は送らない", () => {
    const before = scenarioFormOf(undefined);
    const form = (f: Partial<ScenarioForm>): ScenarioForm => ({ name: "新しい", description: "", rows: [], ...f });
    expect(() => scenarioPatchOf(undefined, before, form({ name: " " }), [])).toThrow(/名前が空/);
    expect(() => scenarioPatchOf(undefined, before, form({ name: BASELINE_NAME }), [])).toThrow(/何も変えない実行/);
    expect(() => scenarioPatchOf(undefined, before, form({ name: "高い" }), ["高い"])).toThrow(/すでにあります/);
    expect(() => scenarioPatchOf(undefined, before, form({ rows: [{ element: "Rate", value: "1" }, { element: "rate", value: "2" }] }), [])).toThrow(/2 行あります/);
    expect(() => scenarioPatchOf(undefined, before, form({ rows: [{ element: "Rate", value: " " }] }), [])).toThrow(/値が空/);
    expect(() => scenarioPatchOf(undefined, before, form({ rows: [{ element: "", value: "1" }] }), [])).toThrow(/1 行目の要素/);
  });
});
