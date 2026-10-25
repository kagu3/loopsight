// シミュレーションの設定（開始時刻、期間、刻み幅、解法、時間の単位）の欄の中身と、送る変更の組み立て。React に依存しない（テストから直接使う）。
// 確かめは MCP の set_simulation と同じもの（core の simulationIssues）を使い、誤りはその欄の近くに出す。
import type { SimulationSettings } from "../../src/viewer/api.js";
import { simulationIssues } from "../../src/core/edit.js";
import { emptyModel, TIME_UNITS, type TimeUnits } from "../../src/core/modeljson.js";
import { halfWidthEquation } from "./editing.js";
import { formatTime, TIME_UNIT_LABEL } from "./format.js";

/** モデルに書いていない項目の値（新しく作るモデルの既定と同じ） */
const DEFAULTS = emptyModel("").simulation as Required<SimulationSettings>;

/** 解法の名前 */
export const ALGORITHM_LABEL: Record<"RK1" | "RK4", string> = {
  RK1: "RK1（オイラー法。速い）",
  RK4: "RK4（ルンゲ＝クッタ法。細かい）",
};

/** 時間の単位の名前（年、月など） */
export const unitLabelOf = (u: string) => TIME_UNIT_LABEL[u.toLowerCase()] ?? u;

/** 欄の中身。数は打ったままの文字で持つ */
export interface SimulationForm {
  time_start: string;
  time_length: string;
  time_step: string;
  algorithm: "RK1" | "RK4";
  time_units: TimeUnits;
}

/** いまの設定から欄の中身を作る。書いていない項目は既定の値にする */
export function simulationFormOf(s: SimulationSettings | undefined): SimulationForm {
  const v = { ...DEFAULTS, ...(s ?? {}) };
  return {
    time_start: String(v.time_start),
    time_length: String(v.time_length),
    time_step: String(v.time_step),
    algorithm: v.algorithm === "RK4" ? "RK4" : "RK1",
    time_units: TIME_UNITS.includes(v.time_units) ? v.time_units : DEFAULTS.time_units,
  };
}

/** 1 つの項目が同じ値か（数は値で比べる。「1」と「1.0」は同じ） */
function sameField(a: SimulationForm, b: SimulationForm, k: keyof SimulationForm): boolean {
  const num = (t: string) => parseNumber(t) ?? t;
  return k === "algorithm" || k === "time_units" ? a[k] === b[k] : num(a[k]) === num(b[k]);
}

const FORM_FIELDS = ["time_start", "time_length", "time_step", "algorithm", "time_units"] as const;

/** 2 つの欄の中身が同じ設定か */
export function sameSimulationForm(a: SimulationForm, b: SimulationForm): boolean {
  return FORM_FIELDS.every((k) => sameField(a, b, k));
}

/**
 * 編集しているあいだに、ほかのところ（AI など）で設定が変わったときの欄の中身。
 * 人が直していない項目（base のままの項目）は、いまの設定（latest）に入れ替える。
 * 人が直した項目だけを残し、もう一度保存したときに、AI が変えたほかの項目を消さないようにする
 */
export function rebaseSimulationForm(form: SimulationForm, base: SimulationForm, latest: SimulationForm): SimulationForm {
  const next = { ...form };
  for (const k of FORM_FIELDS) if (sameField(form, base, k)) (next as Record<string, string>)[k] = latest[k];
  return next;
}

/** 保存した設定の欄の中身（保存する前の設定に、送った変更を重ねたもの） */
export function savedSimulationForm(before: SimulationSettings | undefined, patch: SimulationSettings): SimulationForm {
  return simulationFormOf({ ...(before ?? {}), ...patch });
}

/** 打った文字を数にする（全角の数字も読む）。数でなければ undefined */
function parseNumber(text: string): number | undefined {
  const t = halfWidthEquation(text).trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const NUMBER_FIELDS = ["time_start", "time_length", "time_step"] as const;

/** 項目ごとの誤り（その欄の近くに出す） */
export type SimulationErrors = Partial<Record<keyof SimulationSettings, string>>;

/**
 * 保存するときの変更を作る。base は欄を開いた（または前に保存した）ときの中身で、変えた項目だけを送る（MCP の set_simulation と同じく、送らない項目はそのまま）。
 * 誤りがあれば patch は作らず、errors に項目ごとの理由を入れる。何も変えていなければ patch も errors もない
 */
export function simulationPatchOf(base: SimulationForm, form: SimulationForm): { patch?: SimulationSettings; errors: SimulationErrors } {
  const errors: SimulationErrors = {};
  const next: SimulationSettings = { algorithm: form.algorithm, time_units: form.time_units };
  for (const f of NUMBER_FIELDS) {
    const n = parseNumber(form[f]);
    if (n === undefined) errors[f] = "数を入れてください。";
    else next[f] = n;
  }
  // 数として読めた項目は、set_simulation と同じ確かめを通す（期間・刻み幅は正の数、刻み幅は期間以下など）
  for (const issue of simulationIssues(next)) errors[issue.field] ??= issue.message;
  if (Object.keys(errors).length) return { errors };

  const patch: SimulationSettings = {};
  for (const f of NUMBER_FIELDS) if (parseNumber(base[f]) !== next[f]) patch[f] = next[f];
  if (base.algorithm !== form.algorithm) patch.algorithm = form.algorithm;
  if (base.time_units !== form.time_units) patch.time_units = form.time_units;
  return Object.keys(patch).length ? { patch, errors } : { errors };
}

/** 設定を短く書く（グラフの上のボタンに出す。「0〜100（年）」） */
export function simulationRangeText(s: SimulationSettings | undefined): string {
  const f = simulationFormOf(s);
  const start = Number(f.time_start);
  return `${formatTime(start)}〜${formatTime(start + Number(f.time_length))}（${unitLabelOf(f.time_units)}）`;
}

/** 設定をすべて書く（ボタンの説明や、AI などが先に変えたときの知らせに出す） */
export function describeSimulation(s: SimulationSettings | undefined): string {
  const f = simulationFormOf(s);
  return `開始 ${formatTime(Number(f.time_start))}、期間 ${formatTime(Number(f.time_length))}、刻み幅 ${formatTime(Number(f.time_step))}（単位：${unitLabelOf(f.time_units)}）、解法 ${f.algorithm}`;
}
