// 施策（シナリオ）を重ねて比べるときと、画面で施策を直すときの、React に依存しない計算。
import type { Equation, ModelElement, ModelJSON, RunResult, Scenario, ScenarioPatch, ScenarioRunResult } from "../../src/viewer/api.js";
import { parseEquation } from "./editing.js";

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

// ここから、施策の編集欄（ScenarioEditor）の計算。送る変更は MCP の set_scenarios と同じ形にする

/** 名前は大文字と小文字、前後の空白を区別しない（サーバーの sameName と同じ） */
const nameKey = (name: string) => name.trim().toLowerCase();

/** 施策の名前。名前のない施策は、サーバーと同じく「scenario 1」のように呼ぶ */
export const scenarioName = (s: Scenario, i: number) => s.name ?? `scenario ${i + 1}`;

/** モデルに保存した施策を名前で探す */
export function findScenario(model: ModelJSON, name: string): Scenario | undefined {
  return (model.scenarios ?? []).find((s, i) => nameKey(scenarioName(s, i)) === nameKey(name));
}

/** 施策で値を変えられる要素の種類。画面で選べるのはストック・変数・フロー */
const VALUE_TYPES = new Set<ModelElement["type"]>(["STOCK", "VARIABLE", "FLOW"]);

/** 施策で値を変えられる要素（モデルの並び順） */
export function valueTargets(model: ModelJSON): ModelElement[] {
  return model.elements.filter((e) => e.name && VALUE_TYPES.has(e.type));
}

/** いまのモデルの値（何もしない場合）。ストックは初期値、変数とフローは式。要素がなければ undefined */
export function currentValueOf(model: ModelJSON, name: string): string | undefined {
  const el = model.elements.find((e) => e.type !== "LINK" && e.name && nameKey(e.name) === nameKey(name));
  const v = el?.type === "STOCK" ? el.behavior?.initial_value : el?.behavior?.value;
  return v === undefined ? undefined : String(v);
}

/** 変える値の表の 1 行。value は入れた文字のまま */
export interface ValueRow {
  element: string;
  value: string;
}

export interface ScenarioForm {
  name: string;
  description: string;
  rows: ValueRow[];
}

/**
 * 施策の編集欄のはじめの中身。施策がなければ（足すとき）空。
 * model を渡すと、行の要素名をモデルの表記にそろえる（手で書いたファイルの "rate" を "Rate" に。要素を選ぶ欄で選べるように）
 */
export function scenarioFormOf(s: Scenario | undefined, name = "", model?: ModelJSON): ScenarioForm {
  const notation = (key: string) => model?.elements.find((e) => e.type !== "LINK" && e.name && nameKey(e.name) === nameKey(key))?.name ?? key;
  return {
    name: s?.name ?? name,
    description: s?.description ?? "",
    rows: Object.entries(s?.values ?? {}).map(([element, v]) => ({ element: notation(element), value: String(v) })),
  };
}

/** 表から空の行を除き、誤りがあれば知らせる。同じ要素は 1 行だけ */
function checkRows(rows: ValueRow[]): ValueRow[] {
  const out: ValueRow[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const element = r.element.trim();
    const value = r.value.trim();
    if (!element && !value) continue;
    if (!element) throw new Error(`${i + 1} 行目の要素を選んでください。`);
    if (!value) throw new Error(`「${element}」の値が空です。変えないなら、その行を消してください。`);
    if (seen.has(nameKey(element))) throw new Error(`「${element}」が 2 行あります。1 つの施策の中で、同じ要素は 1 行にしてください。`);
    seen.add(nameKey(element));
    out.push({ element, value });
  }
  return out;
}

/**
 * 編集欄の中身から、送る変更を組み立てる。変えた項目だけにする（値は変えた行だけ、消した行は null）。
 * original は直す施策の名前（足すときは undefined）。others はほかの施策の名前（名前の重なりを確かめる）。
 * 何も変えていなければ undefined。誤りがあれば例外を投げる
 */
export function scenarioPatchOf(original: string | undefined, before: ScenarioForm, after: ScenarioForm, others: string[]): ScenarioPatch | undefined {
  const name = after.name.trim();
  if (!name) throw new Error("施策の名前が空です。");
  if (nameKey(name) === nameKey(BASELINE_NAME)) throw new Error(`「${BASELINE_NAME}」は何も変えない実行の名前なので、施策には使えません。`);
  if (others.some((n) => nameKey(n) === nameKey(name))) throw new Error(`「${name}」という名前の施策がすでにあります。`);
  const rows = checkRows(after.rows);
  const description = after.description.trim();

  if (original === undefined) {
    const patch: ScenarioPatch = { name, values: Object.fromEntries(rows.map((r) => [r.element, parseEquation(r.value)])) };
    if (description) patch.description = description;
    return patch;
  }

  const patch: ScenarioPatch = { name: original };
  if (name !== original) patch.rename_to = name;
  if (description !== before.description.trim()) patch.description = description || null;
  const old = new Map(before.rows.map((r) => [nameKey(r.element), r]));
  const values: Record<string, Equation | null> = {};
  for (const r of rows) {
    const prev = old.get(nameKey(r.element));
    // 要素の表記だけを変えたとき（rate → Rate）も送る（サーバーが要素の表記にそろえる）
    if (!prev || prev.value.trim() !== r.value || prev.element !== r.element) values[r.element] = parseEquation(r.value);
  }
  const kept = new Set(rows.map((r) => nameKey(r.element)));
  for (const r of before.rows) if (!kept.has(nameKey(r.element))) values[r.element] = null;
  if (Object.keys(values).length) patch.values = values;
  return Object.keys(patch).length > 1 ? patch : undefined;
}
