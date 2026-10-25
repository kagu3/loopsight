import { describe, expect, test } from "vitest";
import { simulationIssues } from "../src/core/index.js";
import { describeSimulation, rebaseSimulationForm, sameSimulationForm, savedSimulationForm, simulationFormOf, simulationPatchOf, simulationRangeText } from "../web/src/simulation.js";

describe("ビューアのシミュレーションの設定の欄", () => {
  const base = simulationFormOf({ algorithm: "RK1", time_start: 0, time_length: 100, time_step: 1, time_units: "YEARS" });

  test("書いていない項目は既定の値（開始 0、期間 100、刻み幅 1、RK1、年）で欄に出す", () => {
    expect(simulationFormOf(undefined)).toEqual({ time_start: "0", time_length: "100", time_step: "1", algorithm: "RK1", time_units: "YEARS" });
    expect(simulationFormOf({ time_length: 20, time_units: "DAYS" })).toMatchObject({ time_length: "20", time_units: "DAYS", time_step: "1" });
  });

  test("変えた項目だけを、set_simulation と同じ形で送る。全角の数字も読む。何も変えていなければ送らない", () => {
    expect(simulationPatchOf(base, { ...base, time_length: "２０", algorithm: "RK4" })).toEqual({ patch: { time_length: 20, algorithm: "RK4" }, errors: {} });
    expect(simulationPatchOf(base, { ...base, time_start: " 2020 " }).patch).toEqual({ time_start: 2020 });
    expect(simulationPatchOf(base, { ...base, time_step: "1.0" })).toEqual({ errors: {} });
    expect(simulationPatchOf(base, base)).toEqual({ errors: {} });
  });

  test("誤りは項目ごとに、set_simulation と同じ文で返し、変更は作らない", () => {
    expect(simulationPatchOf(base, { ...base, time_length: "0" })).toEqual({ errors: { time_length: simulationIssues({ time_length: 0 })[0]!.message } });
    expect(simulationPatchOf(base, { ...base, time_step: "-1" }).errors).toEqual({ time_step: expect.stringMatching(/刻み幅）は正の数/) });
    expect(simulationPatchOf(base, { ...base, time_length: "10", time_step: "20" }).errors).toEqual({ time_step: expect.stringMatching(/期間）より大きく/) });
    // 数でない・空の欄は、その欄に出す。ほかの欄の誤りもいっしょに出す
    expect(simulationPatchOf(base, { ...base, time_start: "", time_length: "abc", time_step: "0" }).errors).toEqual({
      time_start: "数を入れてください。",
      time_length: "数を入れてください。",
      time_step: expect.stringMatching(/刻み幅）は正の数/),
    });
  });

  test("同じ設定かは値で比べる（AI などが先に変えたかを確かめるため）", () => {
    expect(sameSimulationForm(base, { ...base, time_step: "1.0" })).toBe(true);
    expect(sameSimulationForm(base, { ...base, time_units: "MONTHS" })).toBe(false);
  });

  test("編集中に AI が別の項目を変えたら、直していない欄はいまの設定にし、もう一度保存しても AI の変更を消さない", () => {
    // 人は期間を 30 に、AI は刻み幅を 0.5 にした
    const form = { ...base, time_length: "30" };
    const latest = { ...base, time_step: "0.5" };
    const rebased = rebaseSimulationForm(form, base, latest);
    expect(rebased).toEqual({ ...base, time_length: "30", time_step: "0.5" });
    expect(simulationPatchOf(latest, rebased).patch).toEqual({ time_length: 30 });
    // 同じ項目を両方が変えたときは、人の値を残す（もう一度保存すると上書きする）
    expect(rebaseSimulationForm(form, base, { ...base, time_length: "40" }).time_length).toBe("30");
  });

  test("保存したあとの欄は、保存する前の設定に送った変更を重ねたもの（全角で打った数も読みやすく直す）", () => {
    expect(savedSimulationForm({ time_length: 50, time_step: 1, time_units: "YEARS" }, { time_step: 0.5 })).toMatchObject({ time_length: "50", time_step: "0.5" });
  });

  test("ボタンと知らせに出す書き方", () => {
    expect(simulationRangeText({ time_start: 2000, time_length: 30, time_units: "YEARS" })).toBe("2000〜2030（年）");
    expect(describeSimulation({ time_start: 0, time_length: 12, time_step: 0.25, algorithm: "RK4", time_units: "MONTHS" })).toBe("開始 0、期間 12、刻み幅 0.25（単位：月）、解法 RK4");
  });
});
