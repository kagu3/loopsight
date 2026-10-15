import { Link } from "simulation";
import type { Equation, ModelElement, ModelJSON, SimulationSettings } from "./modeljson.js";
import { clone, didYouMean, findElement } from "./modeljson.js";
import { checkSimulation } from "./edit.js";
import { ModelError, buildModel, staticCheck, toModelError } from "./validate.js";

/** 実行 1 回分の全データ */
export interface RunData {
  timeUnits: string;
  times: number[];
  /** 要素名 → 各時刻の値 */
  columns: Map<string, unknown[]>;
}

export interface RunOptions {
  /** 一時的に変える値。STOCK は初期値、VARIABLE と FLOW は式を置き換える。ファイルは変えない。 */
  overrides?: Record<string, Equation>;
  /** 一時的に変えるシミュレーション設定 */
  simulation?: SimulationSettings;
}

/** 数値の系列の要約 */
export interface SeriesSummary {
  initial: unknown;
  final: unknown;
  min?: number;
  max?: number;
  min_time?: number;
  max_time?: number;
  /** 間引いた時系列 [時刻, 値] */
  series?: [number, unknown][];
}

export interface RunSummary {
  time_units: string;
  time_start: number;
  time_end: number;
  steps: number;
  overrides?: Record<string, Equation>;
  results: Record<string, SeriesSummary>;
}

/** 値を変えられる要素（STOCK、VARIABLE、FLOW）の名前 */
function valueNames(model: ModelJSON): string[] {
  return model.elements.filter((e) => e.type === "STOCK" || e.type === "VARIABLE" || e.type === "FLOW").map((e) => e.name!);
}

/** 「見つかりません」の issue。似た名前があればヒントに出す */
function notFound(name: string, candidates: string[], what: string): { element: string; message: string; hint?: string } {
  const issue: { element: string; message: string; hint?: string } = { element: name, message: `${what}: ${candidates.join(", ")}` };
  const guess = didYouMean(name, candidates);
  if (guess) issue.hint = guess;
  return issue;
}

/** 上書きを当てたモデルのコピーを作る（元のモデルは変えない） */
export function applyOverrides(model: ModelJSON, options: RunOptions = {}): ModelJSON {
  const copy = clone(model);
  if (options.simulation) {
    copy.simulation = { ...(copy.simulation ?? {}), ...options.simulation };
    try {
      checkSimulation(copy.simulation);
    } catch (e) {
      throw new ModelError("シミュレーション設定の上書きが正しくありません。", [{ message: (e as Error).message }]);
    }
  }
  for (const [name, value] of Object.entries(options.overrides ?? {})) {
    const el = findElement(copy, name);
    if (!el) {
      const candidates = valueNames(copy);
      throw new ModelError(`上書きする要素 "${name}" が見つかりません。`, [notFound(name, candidates, "上書きできる要素")]);
    }
    setValue(el, value);
  }
  return copy;
}

function setValue(el: ModelElement, value: Equation): void {
  el.behavior ??= {};
  if (el.type === "STOCK" || el.type === "STATE") el.behavior.initial_value = value;
  else if (el.type === "VARIABLE" || el.type === "FLOW" || el.type === "TRANSITION") el.behavior.value = value;
  else throw new ModelError(`${el.type} "${el.name}" の値は上書きできません。`, [{ element: el.name, message: "上書きできるのは STOCK（初期値）、VARIABLE、FLOW です。" }]);
}

/** モデルを実行して全データを返す */
export function runModel(model: ModelJSON, options: RunOptions = {}): RunData {
  const applied = applyOverrides(model, options);
  // 存在しない要素の参照などは、エンジンより先に見つけてわかりやすく返す
  const { errors } = staticCheck(applied);
  if (errors.length) throw new ModelError(`モデルにエラーがあるため実行できません（${errors.length} 件）。validate_model でも確かめられます。`, errors);
  const m = buildModel(applied);
  let results;
  try {
    results = m.simulate();
  } catch (e) {
    throw toModelError(e);
  }
  const columns = new Map<string, unknown[]>();
  for (const p of m.find((x) => !(x instanceof Link))) {
    const el = findElement(model, p.name);
    if (!el || el.type === "LINK" || el.type === "TRANSITION") continue;
    try {
      columns.set(el.name!, results.series(p));
    } catch {
      // 結果を持たない要素（エンジンが記録しないもの）は飛ばす
    }
  }
  return { timeUnits: results.timeUnits ?? model.simulation?.time_units?.toLowerCase() ?? "", times: results.times(), columns };
}

/** 要約に使う既定の要素：ストック。ストックがなければ LINK 以外すべて */
export function defaultTargets(model: ModelJSON): string[] {
  const stocks = model.elements.filter((e) => e.type === "STOCK").map((e) => e.name!);
  if (stocks.length) return stocks;
  return model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
}

/** 要約する要素名を、モデルの表記に合わせて確かめる */
export function resolveTargets(model: ModelJSON, targets: string[] | undefined): string[] {
  if (!targets?.length) return defaultTargets(model);
  return targets.map((t) => {
    const el = findElement(model, t);
    if (!el) {
      const names = model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
      throw new ModelError(`要素 "${t}" が見つかりません。`, [notFound(t, names, "ある要素")]);
    }
    return el.name!;
  });
}

/** 有効数字 6 桁に丸める（AI に返すトークンを減らす） */
export function round(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? Number(v.toPrecision(6)) : v;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return undefined;
}

/** 先頭と末尾を含めて n 点に間引いた位置 */
export function sampleIndices(length: number, n: number): number[] {
  if (length <= 0 || n <= 0) return [];
  if (n >= length) return [...Array(length).keys()];
  if (n === 1) return [length - 1];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round((i * (length - 1)) / (n - 1)));
  return [...out];
}

export function summarizeSeries(times: number[], values: unknown[], samples: number): SeriesSummary {
  const s: SeriesSummary = { initial: round(values[0]), final: round(values[values.length - 1]) };
  let min = Infinity;
  let max = -Infinity;
  let minT = 0;
  let maxT = 0;
  let numeric = true;
  values.forEach((v, i) => {
    const n = asNumber(v);
    if (n === undefined) {
      numeric = false;
      return;
    }
    if (n < min) [min, minT] = [n, times[i]!];
    if (n > max) [max, maxT] = [n, times[i]!];
  });
  if (numeric && values.length) {
    Object.assign(s, { min: round(min), max: round(max), min_time: round(minT), max_time: round(maxT) });
  }
  if (samples > 0) s.series = sampleIndices(times.length, samples).map((i) => [round(times[i]) as number, round(values[i])]);
  return s;
}

export function summarizeRun(data: RunData, targets: string[], samples = 11): Omit<RunSummary, "overrides"> {
  const results: Record<string, SeriesSummary> = {};
  for (const t of targets) {
    const col = data.columns.get(t);
    if (col) results[t] = summarizeSeries(data.times, col, samples);
  }
  return {
    time_units: data.timeUnits,
    time_start: data.times[0] ?? 0,
    time_end: data.times[data.times.length - 1] ?? 0,
    steps: data.times.length,
    results,
  };
}

function csvField(v: unknown): string {
  const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 全データを CSV にする（1 列目が時刻） */
export function runToCSV(data: RunData, columns?: string[]): string {
  const names = columns ?? [...data.columns.keys()];
  const lines = [["Time", ...names].map(csvField).join(",")];
  data.times.forEach((t, i) => {
    lines.push([t, ...names.map((n) => data.columns.get(n)?.[i])].map(csvField).join(","));
  });
  return lines.join("\n") + "\n";
}

export interface ScenarioInput {
  name: string;
  overrides: Record<string, Equation>;
}

export interface ComparisonRow {
  scenario: string;
  overrides: Record<string, Equation>;
  results: Record<string, SeriesSummary>;
}

export interface Comparison {
  targets: string[];
  time_units: string;
  rows: ComparisonRow[];
}

/** 複数のシナリオを実行して、指定した要素の結果を並べる */
export function compareScenarios(
  model: ModelJSON,
  scenarios: ScenarioInput[],
  options: { targets?: string[]; samples?: number; simulation?: SimulationSettings } = {},
): Comparison {
  if (!scenarios.length) throw new ModelError("比較するシナリオがありません。", []);
  if (scenarios.length > 200) throw new ModelError("一度に比較できるのは 200 通りまでです。", []);
  const targets = resolveTargets(model, options.targets);
  let timeUnits = "";
  const rows = scenarios.map((sc) => {
    let data: RunData;
    try {
      data = runModel(model, { overrides: sc.overrides, simulation: options.simulation });
    } catch (e) {
      const err = toModelError(e);
      throw new ModelError(`シナリオ "${sc.name}" の実行でエラーが出ました。${err.message}`, err.issues);
    }
    timeUnits = data.timeUnits;
    return { scenario: sc.name, overrides: sc.overrides, results: summarizeRun(data, targets, options.samples ?? 0).results };
  });
  return { targets, time_units: timeUnits, rows };
}

/** 値の並びを作る：values をそのまま使うか、from〜to を steps 等分する */
export function sweepValues(spec: { values?: number[]; from?: number; to?: number; steps?: number }): number[] {
  if (spec.values?.length) return spec.values;
  if (spec.from === undefined || spec.to === undefined) throw new ModelError("values か、from と to を指定してください。", []);
  const steps = spec.steps ?? 5;
  if (!(steps >= 2 && steps <= 200)) throw new ModelError("steps は 2〜200 にしてください。", []);
  return [...Array(steps).keys()].map((i) => round(spec.from! + ((spec.to! - spec.from!) * i) / (steps - 1)) as number);
}

/** 1 つのパラメータを振って比較する */
export function sweepParameter(
  model: ModelJSON,
  parameter: string,
  values: Equation[],
  options: { targets?: string[]; samples?: number; simulation?: SimulationSettings; baseOverrides?: Record<string, Equation> } = {},
): Comparison {
  const el = findElement(model, parameter);
  if (!el) throw new ModelError(`パラメータ "${parameter}" が見つかりません。`, [notFound(parameter, valueNames(model), "振れる要素（STOCK、VARIABLE、FLOW）")]);
  const scenarios = values.map((v) => ({ name: `${el.name} = ${v}`, overrides: { ...(options.baseOverrides ?? {}), [el.name!]: v } }));
  return compareScenarios(model, scenarios, options);
}

/** モデルに保存されているシナリオ（ModelJSON の scenarios）を比較用の形にする */
export function modelScenarios(model: ModelJSON): ScenarioInput[] {
  return (model.scenarios ?? []).map((s, i) => ({ name: s.name ?? `scenario ${i + 1}`, overrides: s.values }));
}
