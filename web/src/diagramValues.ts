// 図の要素に出す値（図の欄の「値を表示」をオンにしたとき）の計算（React に依存しない）。
// 値は、その時点の値と、シミュレーションの最初の時点の値からの変化（例：120（+20%））。
// グラフにカーソルを乗せていればその時刻の値、乗せていなければ要素ごとに最初の値から一番大きく離れた時点の値を出す。

import type { RunResult, ScenarioRunResult } from "../../src/viewer/api.js";
import { sameTime } from "./actualPoints.js";
import { formatValue } from "./format.js";
import { nameKey } from "./scenarios.js";

/** 最初の値から増えたか、減ったか、変わらないか */
export type ChangeDirection = "up" | "down" | "flat";

/** 図の要素 1 つに出す値 */
export interface NodeValue {
  /** その時点の値（グラフのツールチップと同じ丸め方） */
  value: string;
  /** 最初の時点からの変化（+20%。最初の値が 0 なら差の +12。変わらなければ ±0）。値がないときはなし */
  change?: string;
  direction: ChangeDirection;
  /** 変化の大きさの段階（0：変わらない、1：10% 未満、2：50% 未満、3：150% 未満、4：それより大きい）。色の濃さに使う */
  level: 0 | 1 | 2 | 3 | 4;
  /** 最大の振れを出しているときの、その時点（カーソルの時刻を出しているときはなし） */
  time?: number;
}

/** 同じ値とみなすか（計算の誤差を変化と見ない） */
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** 符号をつける（減ったときは発表モードの変化と同じく「−」にする） */
const signed = (positive: boolean, abs: string) => `${positive ? "+" : "−"}${abs}`;

/** 割合（0.2 → +20%）。10% より小さいときは小数を残す（+0.4% が +0% にならないように） */
function formatPercent(ratio: number): string {
  const abs = Math.abs(ratio * 100);
  return `${signed(ratio > 0, abs.toLocaleString("ja-JP", { maximumFractionDigits: abs >= 10 ? 0 : abs >= 1 ? 1 : 2 }))}%`;
}

/** 最初の値 v0 から v への変化の書き方と向き、大きさの段階 */
export function changeOf(v0: number, v: number): Pick<NodeValue, "change" | "direction" | "level"> {
  if (same(v0, v)) return { change: v0 === 0 ? "±0" : "±0%", direction: "flat", level: 0 };
  const direction = v > v0 ? "up" : "down";
  // 最初の値が 0 なら割合を出せないので、差を出す
  if (v0 === 0) return { change: signed(v > 0, formatValue(Math.abs(v))), direction, level: 2 };
  const ratio = (v - v0) / Math.abs(v0);
  const abs = Math.abs(ratio);
  return { change: formatPercent(ratio), direction, level: abs < 0.1 ? 1 : abs < 0.5 ? 2 : abs < 1.5 ? 3 : 4 };
}

/** at の時刻の行の番号。同じ時刻がなければ、いちばん近い時刻（実際のデータの点の時刻などのとき） */
export function timeIndex(times: number[], at: number): number | undefined {
  if (!times.length || !Number.isFinite(at)) return undefined;
  let best = 0;
  for (let i = 0; i < times.length; i++) {
    if (sameTime(times[i]!, at)) return i;
    if (Math.abs(times[i]! - at) < Math.abs(times[best]! - at)) best = i;
  }
  return best;
}

/** 最初の時点の値。最初の時点に値がなければ、値のある最初の時点 */
const initialOf = (values: (number | null)[]) => (finite(values[0]) ? values[0] : values.find(finite));

/** 最初の値から一番大きく離れた時点（同じ離れ方なら早いほう）の行の番号。値がひとつもなければ undefined */
export function peakIndex(values: (number | null)[]): number | undefined {
  const v0 = initialOf(values);
  if (v0 === undefined) return undefined;
  let peak = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (finite(v) && (peak < 0 || Math.abs(v - v0) > Math.abs(values[peak]! - v0))) peak = i;
  }
  return peak;
}

/**
 * 要素ごとの、図に出す値。要素名（nameKey）→ 値。
 * at（行の番号）があればその時点、なければ要素ごとに最初の値から一番大きく離れた時点（同じ離れ方なら早いほう）の値
 */
export function nodeValues(run: Pick<RunResult, "times" | "series">, at?: number): Map<string, NodeValue> {
  const out = new Map<string, NodeValue>();
  for (const [name, values] of Object.entries(run.series)) {
    const v0 = initialOf(values);
    if (v0 === undefined) continue;
    if (at !== undefined) {
      const v = values[at];
      out.set(nameKey(name), finite(v) ? { value: formatValue(v), ...changeOf(v0, v) } : { value: formatValue(v), direction: "flat", level: 0 });
      continue;
    }
    const peak = peakIndex(values)!;
    const v = values[peak]!;
    const change = changeOf(v0, v);
    // 変わらない要素は、時点を添えない（どの時点も同じ値なので）
    out.set(nameKey(name), { value: formatValue(v), ...change, time: change.direction === "flat" ? undefined : run.times[peak] });
  }
  return out;
}

/** 値を出せるシナリオ（実行できたもの）の名前。図の欄の選択に並べる */
export function valueScenarioNames(scenarios: ScenarioRunResult[] | undefined): string[] {
  return (scenarios ?? []).filter((s) => s.series).map((s) => s.name);
}

/** 値を出すシナリオの実行結果。name がない・実行できなかった・消されたときは undefined（「元のモデル」の値を出す） */
export function valueScenarioRun(scenarios: ScenarioRunResult[] | undefined, name: string | undefined): ScenarioRunResult | undefined {
  if (name === undefined) return undefined;
  return (scenarios ?? []).find((s) => s.series && nameKey(s.name) === nameKey(name));
}
