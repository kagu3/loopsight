import { describe, expect, test } from "vitest";
import {
  ModelError,
  compareScenarios,
  emptyModel,
  modelScenarios,
  runModel,
  runScenarios,
  runToCSV,
  sampleIndices,
  summarizeRun,
  upsertElements,
  withBaseline,
  type ModelJSON,
} from "../src/core/index.js";

function growth(): ModelJSON {
  const m = emptyModel("growth", { time_length: 10, time_units: "YEARS" });
  upsertElements(m, [
    { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
    { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
    { type: "FLOW", name: "Growth", to: "Pop", behavior: { value: "[Pop]*[Rate]" } },
  ]);
  return m;
}

describe("実行と要約", () => {
  test("最終値、最小・最大、間引いた時系列を返す", () => {
    const data = runModel(growth());
    expect(data.times).toHaveLength(11);
    const s = summarizeRun(data, ["Pop"], 3);
    expect(s).toMatchObject({ time_units: "years", time_start: 0, time_end: 10, steps: 11 });
    const pop = s.results.Pop!;
    expect(pop.initial).toBe(100);
    expect(pop.final).toBeCloseTo(100 * 1.1 ** 10, 3);
    expect(pop).toMatchObject({ min: 100, min_time: 0, max_time: 10 });
    expect(pop.series!.map((p) => p[0])).toEqual([0, 5, 10]);
  });

  test("上書きは元のモデルを変えない", () => {
    const m = growth();
    const before = JSON.stringify(m);
    const data = runModel(m, { overrides: { rate: 0, Pop: 50 }, simulation: { time_length: 5 } });
    expect(data.times).toHaveLength(6);
    expect(data.columns.get("Pop")!.at(-1)).toBe(50);
    expect(JSON.stringify(m)).toBe(before);
  });

  test("存在しない要素や不正な設定の上書きはエラーにする", () => {
    expect(() => runModel(growth(), { overrides: { Nope: 1 } })).toThrow(ModelError);
    expect(() => runModel(growth(), { simulation: { time_step: -1 } })).toThrow(ModelError);
  });

  test("存在しない要素を参照していると、実行前に似た名前つきで止める", () => {
    const m = growth();
    upsertElements(m, [{ name: "Growth", behavior: { value: "[Pop]*[Rat]" } }]);
    try {
      runModel(m);
      expect.unreachable();
    } catch (e) {
      const issue = (e as ModelError).issues[0]!;
      expect(issue.message).toMatch(/\[Rat\] を参照していますが、その名前の要素がありません/);
      expect(issue.hint).toMatch(/もしかして "Rate"/);
    }
  });

  test("見つからない上書きの要素は候補を示す", () => {
    try {
      runModel(growth(), { overrides: { Rat: 1 } });
      expect.unreachable();
    } catch (e) {
      const issue = (e as ModelError).issues[0]!;
      expect(issue.message).toMatch(/Pop, Rate, Growth/);
      expect(issue.hint).toMatch(/もしかして "Rate"/);
    }
  });

  test("実行時のエラーは要素名つきの ModelError になる", () => {
    const m = growth();
    upsertElements(m, [{ name: "Rate", behavior: { value: "1 +* 2" } }]);
    try {
      runModel(m);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      expect((e as ModelError).issues[0]!.element).toBe("Rate");
    }
  });

  test("間引き位置は先頭と末尾を含む", () => {
    expect(sampleIndices(101, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(sampleIndices(3, 10)).toEqual([0, 1, 2]);
    expect(sampleIndices(0, 3)).toEqual([]);
  });
});

describe("CSV", () => {
  test("1 列目が時刻で、要素ごとの列が並ぶ", () => {
    const csv = runToCSV(runModel(growth()));
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Time,Pop,Rate,Growth");
    expect(lines).toHaveLength(12);
    expect(lines[1]).toBe("0,100,0.1,10");
  });

  test("カンマを含む名前は引用符で囲む", () => {
    const m = emptyModel("t", { time_length: 1 });
    upsertElements(m, [{ type: "VARIABLE", name: 'a, "b"', behavior: { value: 1 } }]);
    expect(runToCSV(runModel(m)).split("\n")[0]).toBe('Time,"a, ""b"""');
  });
});

describe("比較", () => {
  test("実行できないシナリオは、keepErrors なら行の error に理由を入れる", () => {
    const m = growth();
    m.scenarios = [
      { name: "fast", values: { Rate: 0.2 } },
      { name: "broken", values: { Rate: "[Nope]" } },
    ];
    const scenarios = withBaseline(m, modelScenarios(m));
    expect(() => compareScenarios(m, scenarios)).toThrow(/broken/);
    const c = compareScenarios(m, scenarios, { targets: ["pop"], keepErrors: true });
    expect(c.rows.map((r) => r.scenario)).toEqual(["いまのまま", "fast", "broken"]);
    expect(c.rows[1]!.results!.Pop!.final).toBeCloseTo(100 * 1.2 ** 10, 2);
    expect(c.rows[1]!.results!.Pop!.series).toBeUndefined();
    expect(c.rows[2]!.results).toBeUndefined();
    expect(c.rows[2]!.error).toMatch(/実行できません/);
    expect(c.rows[2]!.issues![0]!.message).toMatch(/\[Nope\]/);
    // ビューアのシナリオの比較（runScenarios）と同じ値になる
    const viewer = runScenarios(m);
    expect(c.rows[0]!.results).toEqual(summarizeRun(viewer.baseline, ["Pop"], 0).results);
    expect(c.rows[1]!.results).toEqual(summarizeRun(viewer.scenarios[0]!.data!, ["Pop"], 0).results);
    expect(c.rows[2]!.error).toBe(viewer.scenarios[1]!.error!.message);
    // 上限の 200 通りは、先頭の基準を除いて数える
    const many = withBaseline(m, [...Array(200).keys()].map((i) => ({ name: `s${i}`, overrides: { Rate: i / 1000 } })));
    expect(compareScenarios(m, many, { targets: ["pop"] }).rows).toHaveLength(201);
    expect(() => compareScenarios(m, [...many, { name: "over", overrides: {} }])).toThrow(/200 通り/);
    // 先頭（比べる基準）の失敗は、keepErrors でも例外にする
    expect(() => compareScenarios(m, [{ name: "base", overrides: { Rate: "[Nope]" } }, ...scenarios], { keepErrors: true })).toThrow(ModelError);
  });

  test("シナリオ比較では複数の値をまとめて変えられる", () => {
    const m = growth();
    m.scenarios = [
      { name: "base", values: {} },
      { name: "small", values: { Pop: 10, Rate: 0.2 } },
    ];
    const c = compareScenarios(m, modelScenarios(m), { samples: 2 });
    expect(c.rows[1]!.results!.Pop!.initial).toBe(10);
    expect(c.rows[1]!.results!.Pop!.series).toHaveLength(2);
  });

  test("何も変えない実行と保存したシナリオの全時系列をまとめて返す", () => {
    const m = growth();
    m.scenarios = [
      { name: "fast", description: "速く増やす", values: { Rate: 0.2 } },
      { name: "broken", values: { Rate: "[Nope]" } },
    ];
    const { baseline, scenarios } = runScenarios(m);
    expect(baseline.columns.get("Pop")!.at(-1)).toBeCloseTo(100 * 1.1 ** 10, 6);
    expect(scenarios.map((s) => s.name)).toEqual(["fast", "broken"]);
    expect(scenarios[0]!.description).toBe("速く増やす");
    expect(scenarios[0]!.data!.times).toEqual(baseline.times);
    expect(scenarios[0]!.data!.columns.get("Pop")!.at(-1)).toBeCloseTo(100 * 1.2 ** 10, 6);
    // 実行できないシナリオは、ほかを止めずに error に入れる
    expect(scenarios[1]!.data).toBeUndefined();
    expect(scenarios[1]!.error).toBeInstanceOf(ModelError);
    expect(withBaseline(m, modelScenarios(m)).map((s) => s.name)).toEqual(["いまのまま", "fast", "broken"]);
    // limit を超えたシナリオは実行せず、名前だけ返す
    const limited = runScenarios(m, { limit: 1 }).scenarios;
    expect(limited[1]).toMatchObject({ name: "broken", skipped: true });
    expect(limited[1]!.data).toBeUndefined();
    expect(limited[1]!.error).toBeUndefined();
  });
});
