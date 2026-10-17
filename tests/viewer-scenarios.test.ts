import { describe, expect, test } from "vitest";
import type { ModelJSON, RunResult, ScenarioRunResult } from "../src/viewer/api.js";
import {
  addableValues,
  BASELINE_NAME,
  canEditValue,
  cellPatchOf,
  changeLabel,
  clearValuePatches,
  compareRuns,
  copyNameOf,
  currentValueOf,
  describeRun,
  findScenario,
  newScenarioPatchOf,
  numberOf,
  resultRows,
  scenarioBadges,
  scenarioFormOf,
  scenarioNameProblem,
  scenarioPatchOf,
  scenarioValueOf,
  valueRows,
  valueTargets,
  type ScenarioForm,
} from "../web/src/scenarios.js";
import { BASELINE_SCENARIO, clone, upsertElements } from "../src/core/index.js";

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

describe("施策の中身の表", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "VARIABLE", name: "Zero", behavior: { value: 0 } },
      { type: "FLOW", name: "Births", to: "Pop", behavior: { value: "[Pop]*[Rate]" } },
      { type: "VARIABLE", name: "Unused", behavior: { value: 5 } },
      { type: "LINK", from: "Rate", to: "Births" },
    ],
  };
  const times = [0, 1, 2];
  const base: RunResult = { time_units: "years", times, series: { Pop: [100, 110, 120] } };
  const runs = compareRuns(
    base,
    [
      // 1 つの施策で 3 つの値を変える。要素名の大文字と小文字は区別しない
      { name: "a", values: { births: "[Pop]*0.2", Rate: 0.15, pop: 50 }, series: { Pop: [50, 60, 180] } },
      { name: "b", values: { Zero: 2, Rate: "0.05" }, series: { Pop: [100, 105, 90] } },
    ],
    8,
  ).runs;

  test("数として読める値だけを数にする。式は数にしない", () => {
    expect(numberOf(0.5)).toBe(0.5);
    expect(numberOf(" 12 ")).toBe(12);
    expect(numberOf("[Pop]*2")).toBeUndefined();
    expect(numberOf("")).toBeUndefined();
    expect(numberOf(true)).toBeUndefined();
    expect(numberOf(undefined)).toBeUndefined();
  });

  test("変化は率で出す。10% 未満は小数 1 桁、それ以上は整数に丸める", () => {
    expect(changeLabel(100, 150)).toBe("+50%");
    expect(changeLabel(100, 75)).toBe("−25%");
    expect(changeLabel(-100, -50)).toBe("+50%");
    expect(changeLabel(100, 103.24)).toBe("+3.2%");
    expect(changeLabel(100, 112.6)).toBe("+13%");
    expect(changeLabel(100, 100.01)).toBe("±0%");
    expect(changeLabel(1, 30)).toBe("+2,900%");
  });

  test("0 からの変化など率にできないときは差。数でなければ添えない", () => {
    expect(changeLabel(0, 2)).toBe("+2");
    expect(changeLabel(0, -0.5)).toBe("−0.5");
    expect(changeLabel(0, 0)).toBe("±0");
    expect(changeLabel(null, 2)).toBe("");
    expect(changeLabel(1, undefined)).toBe("");
    expect(changeLabel(1, Number.NaN)).toBe("");
  });

  test("行はどれかの施策で変えた要素だけ、モデルの並び順。「何もしない場合」はいまの値（ストックは初期値、変数とフローは式）", () => {
    const rows = valueRows(model, runs);
    expect(rows.map((r) => [r.element, r.initial])).toEqual([
      ["Pop", true],
      ["Rate", false],
      ["Zero", false],
      ["Births", false],
    ]);
    expect(rows[0]!.cells).toEqual([
      { value: "100", changed: false, change: "" },
      { value: "50", changed: true, change: "−50%" },
      { changed: false, change: "" },
    ]);
    expect(rows[1]!.cells.map((c) => [c.value, c.change])).toEqual([
      ["0.1", ""],
      ["0.15", "+50%"],
      ["0.05", "−50%"],
    ]);
    // 0 からの変化は差
    expect(rows[2]!.cells[2]).toEqual({ value: "2", changed: true, change: "+2" });
    // 式のときは変化を添えない
    expect(rows[3]!.cells.map((c) => [c.value, c.change])).toEqual([
      ["[Pop]*[Rate]", ""],
      ["[Pop]*0.2", ""],
      [undefined, ""],
    ]);
  });

  test("モデルにない要素の行は最後。施策がなければ行もない", () => {
    const [b0, a] = compareRuns(base, [{ name: "a", values: { Nope: 1, Rate: 0.2 }, series: base.series }], 8).runs;
    expect(valueRows(model, [b0!, a!]).map((r) => r.element)).toEqual(["Rate", "Nope"]);
    expect(valueRows(model, [b0!, a!])[1]!.cells[0]).toEqual({ value: undefined, changed: false, change: "" });
    expect(valueRows(model, [b0!])).toEqual([]);
  });

  test("結果は選んでいる要素ごとに、最後の時点の値と「何もしない場合」からの変化", () => {
    expect(resultRows(runs, times, ["Pop"])).toEqual([
      {
        element: "Pop",
        time: 2,
        cells: [
          { value: 120, change: "" },
          { value: 180, change: "+50%" },
          { value: 90, change: "−25%" },
        ],
      },
    ]);
    expect(resultRows(runs, times, ["Pop", "Missing"])[1]!.cells.map((c) => c.value)).toEqual([null, null, null]);
    expect(resultRows(runs, [], ["Pop"])).toEqual([]);
  });

  test("カーソルを乗せた時点の値に変わる。刻みにない時刻なら、いちばん近い刻み", () => {
    expect(resultRows(runs, times, ["Pop"], 1)[0]!.cells.map((c) => c.value)).toEqual([110, 60, 105]);
    expect(resultRows(runs, times, ["Pop"], 0.2)[0]!.time).toBe(0);
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

describe("図の札（施策で変えた要素）", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "FLOW", name: "Births", to: "Pop", behavior: { value: "[Pop]*[Rate]" } },
      { type: "LINK", from: "Rate", to: "Births" },
    ],
  };

  test("1 つの施策で変えた要素ごとに、いまの値 → 施策の値。ストックは初期値", () => {
    const badges = scenarioBadges(model, { Pop: 200, rate: "0.3", Births: "[Pop]*0.2" });
    expect([...badges.keys()]).toEqual(["pop", "rate", "births"]);
    expect(badges.get("pop")).toMatchObject({ element: "Pop", initial: true, current: "100", value: "200", text: "100 → 200" });
    expect(badges.get("pop")!.title).toBe("Popの初期値\nいまの値：100\n施策の値：200");
    // 要素名の大文字と小文字は区別せず、モデルの表記で出す
    expect(badges.get("rate")).toMatchObject({ element: "Rate", initial: false, text: "0.1 → 0.3" });
    expect(badges.get("births")).toMatchObject({ text: "[Pop]*[Rate] → [Pop]*0.2", title: "Births\nいまの値：[Pop]*[Rate]\n施策の値：[Pop]*0.2" });
  });

  test("長い式は札では省略し、全文はツールチップに出す。複数行の式は 1 行にする", () => {
    const long = "IfThenElse([Pop] > 1000,\n  [Pop]*0.01, 0)";
    const b = scenarioBadges(model, { Births: long }).get("births")!;
    expect(b.text).toBe("[Pop]*[Rate] → IfThenElse(…");
    expect(b.title).toContain(long);
  });

  test("モデルにない要素は図に出ないので、札も作らない。何も変えていなければ空", () => {
    expect([...scenarioBadges(model, { Nope: 1, Rate: 0.2 }).keys()]).toEqual(["rate"]);
    expect(scenarioBadges(model, {}).size).toBe(0);
  });

  test("要素の名前を変えると、施策の値のキーが追従し、札は新しい名前の要素に付く", () => {
    const m = clone({ ...model, scenarios: [{ name: "高い", values: { Rate: 0.2 } }] });
    upsertElements(m, [{ type: "VARIABLE", name: "Rate", rename_to: "Growth" }]);
    const badges = scenarioBadges(m, findScenario(m, "高い")!.values);
    expect([...badges.values()].map((b) => [b.element, b.text])).toEqual([["Growth", "0.1 → 0.2"]]);
  });
});

describe("施策の中身の表で値を直す", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "FLOW", name: "Births", to: "Pop", behavior: { value: "[Pop]*[Rate]" } },
      { type: "LINK", from: "Rate", to: "Births" },
    ],
    scenarios: [{ name: "高い", values: { rate: 0.2 } }, { values: { Pop: 50 } }],
  };

  test("施策に保存してある値は、要素名の大文字と小文字を区別せずに引く", () => {
    expect(scenarioValueOf(model, "高い", "Rate")).toBe("0.2");
    expect(scenarioValueOf(model, "scenario 2", "pop")).toBe("50");
    expect(scenarioValueOf(model, "高い", "Pop")).toBeUndefined();
    expect(scenarioValueOf(model, "ない施策", "Rate")).toBeUndefined();
  });

  test("値を書き換えると、その値 1 つだけを送る。数字だけなら数値、式はそのまま", () => {
    expect(cellPatchOf(model, "高い", "Rate", " 0.3 ")).toEqual({ name: "高い", values: { Rate: 0.3 } });
    expect(cellPatchOf(model, "高い", "Births", "[Pop]*0.2")).toEqual({ name: "高い", values: { Births: "[Pop]*0.2" } });
  });

  test("「—」のマス（変えていない値）からも値を変え始められる。名前のない施策は「scenario 2」で送る", () => {
    expect(cellPatchOf(model, "高い", "Pop", "80")).toEqual({ name: "高い", values: { Pop: 80 } });
    expect(cellPatchOf(model, "scenario 2", "Rate", "0.05")).toEqual({ name: "scenario 2", values: { Rate: 0.05 } });
  });

  test("空にすると、その施策ではその値を変えない（null）。もともと変えていなければ送らない", () => {
    expect(cellPatchOf(model, "高い", "Rate", "  ")).toEqual({ name: "高い", values: { Rate: null } });
    expect(cellPatchOf(model, "高い", "Pop", "")).toBeUndefined();
  });

  test("保存してある値と同じなら送らない", () => {
    expect(cellPatchOf(model, "高い", "Rate", "0.2")).toBeUndefined();
  });

  test("書けない値（かっこの数が合わない、ない要素の参照）は送らない", () => {
    expect(() => cellPatchOf(model, "高い", "Rate", "([Pop]*2")).toThrow(/「\(」と「\)」/);
    expect(() => cellPatchOf(model, "高い", "Rate", "[Pop*2")).toThrow(/「\[」と「\]」/);
    expect(() => cellPatchOf(model, "高い", "Rate", ")(")).toThrow(/数が合いません/);
    expect(() => cellPatchOf(model, "高い", "Rate", "{5 Meters")).toThrow(/「{」と「}」/);
    expect(() => cellPatchOf(model, "高い", "Rate", "[Popp]*2")).toThrow(/「Popp」という要素はありません/);
    expect(cellPatchOf(model, "高い", "Rate", "[pop]*0.001")).toEqual({ name: "高い", values: { Rate: "[pop]*0.001" } });
  });
});

describe("施策の中身の表で値を直す（全角と、直せる行）", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "人口（千人）", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "CONVERTER", name: "Table", behavior: { input: "TIME", data: [[0, 1]] } },
    ],
    scenarios: [{ name: "高い", values: { Rate: 0.3 } }],
  };

  test("全角の数字と記号は半角にして送る。[名前] の中の要素名は変えない", () => {
    expect(cellPatchOf(model, "高い", "Rate", "０.５")).toEqual({ name: "高い", values: { Rate: 0.5 } });
    expect(cellPatchOf(model, "高い", "Rate", "［人口（千人）］＊（１＋２）")).toEqual({ name: "高い", values: { Rate: "[人口（千人）]*(1+2)" } });
    // 全角で打っても、保存してある値と同じなら送らない
    expect(cellPatchOf(model, "高い", "Rate", "０.３")).toBeUndefined();
  });

  test("直せるのは、モデルにあり施策で値を変えられる要素の行だけ", () => {
    expect(canEditValue(model, "rate")).toBe(true);
    expect(canEditValue(model, "人口（千人）")).toBe(true);
    expect(canEditValue(model, "Table")).toBe(false);
    expect(canEditValue(model, "Nope")).toBe(false);
  });
});

describe("施策の中身の表の見出しで施策を足す・複製する", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
    ],
    scenarios: [
      { name: "人を増やさない", description: " 採用を止める ", values: { Rate: 0.05, Pop: 80 } },
      { name: "人を増やさない（2）", values: {} },
      { values: { Rate: 0.3 } },
    ],
  };
  const others = (model.scenarios ?? []).map((s, i) => s.name ?? `scenario ${i + 1}`);

  test("名前は、空・「何もしない場合」・ほかの施策と同じなら使えない。比べ方はサーバーと同じ（大文字と小文字、前後の空白を区別しない）", () => {
    expect(scenarioNameProblem("  ", others)).toMatch(/空です/);
    expect(scenarioNameProblem(` ${BASELINE_NAME} `, others)).toMatch(/何も変えない実行の名前/);
    expect(scenarioNameProblem(" 人を増やさない ", others)).toMatch(/「人を増やさない」という名前の施策がすでにあります/);
    expect(scenarioNameProblem("Scenario 3", others)).toMatch(/すでにあります/);
    expect(scenarioNameProblem("広告を増やす", others)).toBeUndefined();
  });

  test("複製するときの名前は、まだ使っていない番号を付ける。番号つきの施策を複製しても番号を重ねない（全角・半角のかっこ）", () => {
    expect(copyNameOf("人を増やさない", others)).toBe("人を増やさない（3）");
    expect(copyNameOf("人を増やさない（2）", others)).toBe("人を増やさない（3）");
    expect(copyNameOf("scenario 3", others)).toBe("scenario 3（2）");
    // 半角の「 (2)」も番号として付け直す
    expect(copyNameOf("人を増やさない (2)", others)).toBe("人を増やさない（3）");
  });

  test("「＋」で足す施策は、値を変えない施策として送る。名前の前後の空白は除く", () => {
    expect(newScenarioPatchOf(model, " 広告を増やす ")).toEqual({ name: "広告を増やす", values: {} });
  });

  test("複製する施策は、元の値と説明を写す（説明は編集欄と同じく前後の空白を除き、空なら送らない）", () => {
    expect(newScenarioPatchOf(model, "人を増やさない（3）", "人を増やさない")).toEqual({
      name: "人を増やさない（3）",
      description: "採用を止める",
      values: { Rate: 0.05, Pop: 80 },
    });
    expect(newScenarioPatchOf(model, "コピー", "scenario 3")).toEqual({ name: "コピー", values: { Rate: 0.3 } });
  });

  test("名前が使えないとき、複製元が見つからないときは送らない", () => {
    expect(() => newScenarioPatchOf(model, "")).toThrow(/空です/);
    expect(() => newScenarioPatchOf(model, "人を増やさない（2）", "人を増やさない")).toThrow(/すでにあります/);
    expect(() => newScenarioPatchOf(model, "新しい", "消えた施策")).toThrow(/「消えた施策」が見つかりません/);
  });

  test("値を変えない施策も、表の列になる（どの行も「—」）", () => {
    const c = compareRuns(run, [scenario("a"), scenario("空", { values: {}, series: run.series })], 8);
    expect(c.runs.map((r) => r.name)).toEqual([BASELINE_NAME, "a", "空"]);
    const m: ModelJSON = { elements: [{ type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } }] };
    expect(valueRows(m, c.runs).map((r) => r.cells.map((x) => x.value ?? "—"))).toEqual([["0.1", "0.2", "—"]]);
  });
});

describe("施策の中身の表で行（変える値）を足す・消す", () => {
  const model: ModelJSON = {
    elements: [
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "FLOW", name: "Births", behavior: { value: "[Pop]*[Rate]" } },
      { type: "CONVERTER", name: "Table" },
      { type: "VARIABLE", name: "Cap", behavior: { value: 500 } },
    ],
    scenarios: [
      { name: "a", values: { rate: 0.2, Pop: 80 } },
      { name: "b", values: { Pop: 90 } },
      { values: { Rate: 0.3 } },
    ],
  };
  const runs = compareRuns(
    run,
    [scenario("a", { values: { rate: 0.2, Pop: 80 } }), scenario("b", { values: { Pop: 90 } }), scenario("scenario 3", { values: { Rate: 0.3 } })],
    8,
  ).runs;

  test("足した行は、どの施策でも変えていなくても全部「—」で出し、モデルの並び順に並べる", () => {
    const rows = valueRows(model, runs, ["Cap", "Births"]);
    expect(rows.map((r) => r.element)).toEqual(["Pop", "Rate", "Births", "Cap"]);
    expect(rows[2]!.cells.map((c) => c.value ?? "—")).toEqual(["[Pop]*[Rate]", "—", "—", "—"]);
    expect(rows[3]!.cells.map((c) => c.changed)).toEqual([false, false, false, false]);
  });

  test("足した行に値を入れても二重に出さない。施策で変えられない要素やモデルにない要素は出さない", () => {
    expect(valueRows(model, runs, ["rate", "Pop"]).map((r) => r.element)).toEqual(["Pop", "Rate"]);
    expect(valueRows(model, runs, ["Table", "消えた要素"]).map((r) => r.element)).toEqual(["Pop", "Rate"]);
  });

  test("「＋ 値を追加」で選べるのは、施策で変えられる値のうち、まだ行にないもの", () => {
    const rows = valueRows(model, runs, ["Cap"]);
    expect(addableValues(model, rows).map((e) => e.name)).toEqual(["Births"]);
  });

  test("行を消すときは、その値を変えている施策だけに null を送る（名前のない施策も、表記の違う名前もそのまま）", () => {
    expect(clearValuePatches(model, "Rate")).toEqual([
      { name: "a", values: { rate: null } },
      { name: "scenario 3", values: { Rate: null } },
    ]);
    expect(clearValuePatches(model, "pop")).toEqual([
      { name: "a", values: { Pop: null } },
      { name: "b", values: { Pop: null } },
    ]);
    expect(clearValuePatches(model, "Cap")).toEqual([]);
  });
});
