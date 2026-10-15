import { describe, expect, test } from "vitest";
import {
  ModelError,
  compareScenarios,
  emptyModel,
  modelScenarios,
  runModel,
  runToCSV,
  sampleIndices,
  summarizeRun,
  sweepParameter,
  sweepValues,
  upsertElements,
  type ModelJSON,
} from "../src/core/index.js";
import { loadSample } from "./helpers.js";

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

  test("見つからないパラメータや要素は候補を示す", () => {
    try {
      sweepParameter(growth(), "Rat", [1, 2]);
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

  test("状態（0/1）と遷移を含むモデルも要約できる", () => {
    const bath = loadSample("bathtub");
    const s = summarizeRun(runModel(bath), ["Bathtub", "Is Filling"], 0);
    expect(s.results["Is Filling"]).toMatchObject({ initial: 1, final: 0, min: 0, max: 1 });
    expect(s.results.Bathtub!.max).toBe(60);
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
  test("パラメータを振ると値ごとの結果が並ぶ", () => {
    const c = sweepParameter(growth(), "rate", sweepValues({ from: 0, to: 0.2, steps: 3 }), { targets: ["pop"] });
    expect(c.targets).toEqual(["Pop"]);
    expect(c.rows.map((r) => r.scenario)).toEqual(["Rate = 0", "Rate = 0.1", "Rate = 0.2"]);
    const finals = c.rows.map((r) => r.results.Pop!.final as number);
    expect(finals[0]).toBe(100);
    expect(finals[1]).toBeLessThan(finals[2]!);
    expect(c.rows[0]!.results.Pop!.series).toBeUndefined();
  });

  test("シナリオ比較では複数の値をまとめて変えられる", () => {
    const m = growth();
    m.scenarios = [
      { name: "base", values: {} },
      { name: "small", values: { Pop: 10, Rate: 0.2 } },
    ];
    const c = compareScenarios(m, modelScenarios(m), { samples: 2 });
    expect(c.rows[1]!.results.Pop!.initial).toBe(10);
    expect(c.rows[1]!.results.Pop!.series).toHaveLength(2);
  });

  test("値の指定がなければエラー", () => {
    expect(() => sweepValues({})).toThrow(ModelError);
    expect(sweepValues({ values: [1, 3] })).toEqual([1, 3]);
  });
});
