// 施策（シナリオ）を重ねて比べるときの、React に依存しない計算。
import type { Equation, RunResult, ScenarioRunResult } from "../../src/viewer/api.js";

/** 何も変えない実行の名前（サーバーの BASELINE_SCENARIO と同じ） */
export const BASELINE_NAME = "何もしない場合";

/** グラフに重ねる実行 1 つ分。baseline は「何もしない場合」 */
export interface CompareRun {
  name: string;
  description?: string;
  values: Record<string, Equation>;
  series: Record<string, (number | null)[]>;
  baseline: boolean;
}

export interface CompareRuns {
  /** 先頭が「何もしない場合」。続けて、実行できた施策をモデルの並び順で */
  runs: CompareRun[];
  /** 実行できなかった施策 */
  failed: { name: string; error: string }[];
  /** 色が足りないため出さない施策 */
  omitted: string[];
}

/** 「何もしない場合」と施策を、重ねて出す順に並べる。施策は色の数（max）まで */
export function compareRuns(run: RunResult, scenarios: ScenarioRunResult[], max: number): CompareRuns {
  const out: CompareRuns = {
    runs: [{ name: BASELINE_NAME, values: {}, series: run.series, baseline: true }],
    failed: [],
    omitted: [],
  };
  for (const s of scenarios) {
    if (s.skipped) {
      out.omitted.push(s.name);
      continue;
    }
    if (!s.series) {
      out.failed.push({ name: s.name, error: s.error ?? "" });
      continue;
    }
    if (out.runs.length - 1 >= max) {
      out.omitted.push(s.name);
      continue;
    }
    out.runs.push({ name: s.name, description: s.description, values: s.values, series: s.series, baseline: false });
  }
  return out;
}

/** 施策の説明（凡例にカーソルを乗せたときに出す）。説明と、変える値 */
export function describeRun(r: CompareRun): string {
  if (r.baseline) return "モデルの値を何も変えずに実行した結果です";
  const values = Object.entries(r.values).map(([k, v]) => `${k} = ${String(v)}`);
  return [r.description, values.length ? `変える値：${values.join("、")}` : "値を変えていません"].filter(Boolean).join("\n");
}
