// 施策（シナリオ）を重ねて比べるときと、画面で施策を直すときの、React に依存しない計算。
import type { Equation, ModelElement, ModelJSON, RunResult, Scenario, ScenarioPatch, ScenarioRunResult } from "../../src/viewer/api.js";
import { halfWidthEquation, parseEquation } from "./editing.js";

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

// ここから、施策の凡例を開いたときの表（施策の中身）の計算。列は compareRuns の runs と同じ並び

/** 数として読める値なら数。式（数でない文字）なら undefined */
export function numberOf(v: Equation | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

const MINUS = "−";

/**
 * 「何もしない場合」の値から、施策の値への変化の添え書き。
 * 率にできれば +50% / −25%（10% 未満は小数 1 桁まで、それ以上は整数に丸める）。
 * 0 からの変化など率にできなければ差（+0.5）。どちらかが数でなければ空文字
 */
export function changeLabel(base: number | null | undefined, value: number | null | undefined): string {
  if (base == null || value == null || !Number.isFinite(base) || !Number.isFinite(value)) return "";
  if (base === 0) {
    const d = value - base;
    return d === 0 ? "±0" : `${d > 0 ? "+" : MINUS}${Math.abs(d).toLocaleString("ja-JP", { maximumSignificantDigits: 4 })}`;
  }
  const p = ((value - base) / Math.abs(base)) * 100;
  const abs = Math.abs(p);
  const text = abs.toLocaleString("ja-JP", { maximumFractionDigits: abs < 10 ? 1 : 0 });
  if (Number(text.replace(/,/g, "")) === 0) return "±0%";
  return `${p > 0 ? "+" : MINUS}${text}%`;
}

/** 表のマス 1 つ。value は値の書き方のまま（変えていなければ undefined） */
export interface MatrixCell {
  value?: string;
  /** 施策で値を変えたか（「何もしない場合」の列はいつも false） */
  changed: boolean;
  /** 「何もしない場合」からの変化（+50% など）。式のときや変えていないときは空文字 */
  change: string;
}

/** 変えた値の行。cells は runs と同じ並び（先頭が「何もしない場合」） */
export interface MatrixRow {
  element: string;
  /** ストックの行（「何もしない場合」の値は初期値） */
  initial: boolean;
  cells: MatrixCell[];
}

/**
 * 変えた値の行。どれかの施策で変えた要素だけを、モデルの並び順で（モデルにない要素は最後に）。
 * added（表で足した行の要素）は、どの施策でも変えていなくても出す（施策で値を変えられない要素や、モデルにない要素は出さない）。
 * 「何もしない場合」の列はいまの値（ストックは初期値、変数とフローは式）
 */
export function valueRows(model: ModelJSON, runs: CompareRun[], added: string[] = []): MatrixRow[] {
  const scenarios = runs.filter((r) => !r.baseline);
  // 施策の値は、要素名の大文字と小文字を区別せずに引く
  const lookup = scenarios.map((r) => new Map(Object.entries(r.values).map(([k, v]) => [nameKey(k), v])));
  const extra = new Set(added.map(nameKey));
  const changed = new Map<string, string>();
  for (const e of model.elements) {
    if (e.type === "LINK" || !e.name || changed.has(nameKey(e.name))) continue;
    const key = nameKey(e.name);
    if (lookup.some((m) => m.has(key)) || (extra.has(key) && VALUE_TYPES.has(e.type))) changed.set(key, e.name);
  }
  for (const r of scenarios) for (const k of Object.keys(r.values)) if (!changed.has(nameKey(k))) changed.set(nameKey(k), k);

  return [...changed].map(([key, element]) => {
    const current = currentValueOf(model, element);
    const base = numberOf(current);
    const el = model.elements.find((e) => e.type !== "LINK" && e.name && nameKey(e.name) === key);
    let i = 0;
    const cells = runs.map((r): MatrixCell => {
      if (r.baseline) return { value: current, changed: false, change: "" };
      const v = lookup[i++]!.get(key);
      if (v === undefined) return { changed: false, change: "" };
      return { value: String(v), changed: true, change: changeLabel(base, numberOf(v)) };
    });
    return { element, initial: el?.type === "STOCK", cells };
  });
}

/** 結果の行。cells は runs と同じ並び。施策の列の change は「何もしない場合」からの変化 */
export interface ResultRow {
  element: string;
  /** 値を読んだ時点 */
  time: number;
  cells: { value: number | null; change: string }[];
}

/**
 * 結果の行。グラフで選んでいる要素ごとに、時点 at の値（at がなければ最後の時点）。
 * at は刻みの時刻（グラフにカーソルを乗せた時点）。刻みにない時刻なら、いちばん近い刻みの値を出す
 */
export function resultRows(runs: CompareRun[], times: number[], elements: string[], at?: number): ResultRow[] {
  if (times.length === 0) return [];
  let i = times.length - 1;
  if (at !== undefined) {
    i = 0;
    for (const [j, t] of times.entries()) if (Math.abs(t - at) < Math.abs(times[i]! - at)) i = j;
  }
  return elements.map((element) => {
    const base = runs[0]?.series[element]?.[i] ?? null;
    return {
      element,
      time: times[i]!,
      cells: runs.map((r) => {
        const value = r.series[element]?.[i] ?? null;
        return { value, change: r.baseline ? "" : changeLabel(base, value) };
      }),
    };
  });
}

// ここから、施策の編集欄（ScenarioEditor）の計算。送る変更は MCP の set_scenarios と同じ形にする

/** 名前は大文字と小文字、前後の空白を区別しない（サーバーの sameName と同じ） */
export const nameKey = (name: string) => name.trim().toLowerCase();

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
 * 施策の名前に使えない理由。空、「何もしない場合」、ほかの施策（others）と同じ名前。使えれば undefined。
 * 比べ方はサーバーの setScenarios と同じ（大文字と小文字、前後の空白を区別しない）
 */
export function scenarioNameProblem(name: string, others: string[]): string | undefined {
  const n = name.trim();
  if (!n) return "施策の名前が空です。";
  if (nameKey(n) === nameKey(BASELINE_NAME)) return `「${BASELINE_NAME}」は何も変えない実行の名前なので、施策には使えません。`;
  if (others.some((o) => nameKey(o) === nameKey(n))) return `「${n}」という名前の施策がすでにあります。`;
  return undefined;
}

/**
 * 編集欄の中身から、送る変更を組み立てる。変えた項目だけにする（値は変えた行だけ、消した行は null）。
 * original は直す施策の名前（足すときは undefined）。others はほかの施策の名前（名前の重なりを確かめる）。
 * 何も変えていなければ undefined。誤りがあれば例外を投げる
 */
export function scenarioPatchOf(original: string | undefined, before: ScenarioForm, after: ScenarioForm, others: string[]): ScenarioPatch | undefined {
  const name = after.name.trim();
  const problem = scenarioNameProblem(name, others);
  if (problem) throw new Error(problem);
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

// ここから、施策に注目している間（凡例にカーソルを乗せている・左の欄で直している）に、図の変えた要素に付ける札の計算

/** 図の札 1 つ分 */
export interface ScenarioBadge {
  /** 要素の名前（モデルの表記） */
  element: string;
  /** ストック（いまの値・施策の値は初期値） */
  initial: boolean;
  /** いまの値（何もしない場合）。値のない要素なら空文字 */
  current: string;
  /** 施策の値 */
  value: string;
  /** 札に出す文字（「20 → 80」。長い式は省略する） */
  text: string;
  /** 全文（ツールチップ） */
  title: string;
}

/** 札の中で、値 1 つに使う文字数。これより長い式は省略する */
const BADGE_VALUE_CHARS = 12;
/** 札に出す値。1 行にし（複数行の式は空白でつなぐ）、長ければ省略する */
function badgeValue(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > BADGE_VALUE_CHARS ? `${line.slice(0, BADGE_VALUE_CHARS - 1)}…` : line;
}

/**
 * 施策で変えた要素の札。要素名（nameKey）→ 札。
 * 値は施策に保存してある値（編集欄で入れている途中の値ではない）。モデルにない要素は図に出ないので除く
 */
export function scenarioBadges(model: ModelJSON, values: Record<string, Equation>): Map<string, ScenarioBadge> {
  const out = new Map<string, ScenarioBadge>();
  for (const [key, v] of Object.entries(values)) {
    const el = model.elements.find((e) => e.type !== "LINK" && e.name && nameKey(e.name) === nameKey(key));
    if (!el?.name) continue;
    const initial = el.type === "STOCK";
    const current = currentValueOf(model, el.name) ?? "";
    const value = String(v).trim();
    const text = `${badgeValue(current) || "—"} → ${badgeValue(value)}`;
    const title = [`${el.name}${initial ? "の初期値" : ""}`, `いまの値：${current.trim() || "—"}`, `施策の値：${value}`].join("\n");
    out.set(nameKey(el.name), { element: el.name, initial, current, value, text, title });
  }
  return out;
}

// ここから、施策の中身の表のマスで、施策の値をその場で直すときの計算。送る変更は施策の編集欄と同じ形（値 1 つだけ）

/** 施策に保存してある要素の値（書き方のまま）。施策がないか、その値を変えていなければ undefined */
export function scenarioValueOf(model: ModelJSON, scenario: string, element: string): string | undefined {
  const v = Object.entries(findScenario(model, scenario)?.values ?? {}).find(([k]) => nameKey(k) === nameKey(element))?.[1];
  return v === undefined ? undefined : String(v);
}

/** 表のマスで直せる値か。モデルにあり、施策で値を変えられる要素（ストック・変数・フロー）だけ。ほかは保存できない */
export function canEditValue(model: ModelJSON, element: string): boolean {
  return valueTargets(model).some((e) => nameKey(e.name!) === nameKey(element));
}

/** 式として書けない値なら、その理由。かっこ（( ) [ ] { }）の数が合わない、ない要素を [名前] で参照している */
function valueProblem(model: ModelJSON, text: string): string | undefined {
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    let depth = 0;
    for (const ch of text) {
      if (ch === open) depth++;
      else if (ch === close && --depth < 0) break;
    }
    if (depth !== 0) return `「${open}」と「${close}」の数が合いません。`;
  }
  for (const m of text.matchAll(/\[([^[\]\n]+)\]/g)) {
    const ref = m[1]!.trim();
    if (!model.elements.some((e) => e.type !== "LINK" && e.name && nameKey(e.name) === nameKey(ref))) return `「${ref}」という要素はありません。`;
  }
  return undefined;
}

/**
 * 表のマスに入れた文字から、送る変更を組み立てる（MCP の set_scenarios と同じ形）。
 * 空なら、その施策ではその値を変えない（null。「何もしない場合」と同じ値に戻る）。全角の数字と記号は半角にする。
 * 保存してある値と同じなら（何も変えていなければ）undefined。書けない値なら例外を投げる
 */
export function cellPatchOf(model: ModelJSON, scenario: string, element: string, text: string): ScenarioPatch | undefined {
  const value = halfWidthEquation(text).trim();
  const saved = scenarioValueOf(model, scenario, element);
  if (!value) return saved === undefined ? undefined : { name: scenario, values: { [element]: null } };
  if (saved !== undefined && saved.trim() === value) return undefined;
  const problem = valueProblem(model, value);
  if (problem) throw new Error(problem);
  return { name: scenario, values: { [element]: parseEquation(value) } };
}

// ここから、施策の中身の表の見出しで、施策を足す・複製するときの計算。送る変更は施策の編集欄で足すときと同じ形

/** 複製するときに最初に入れておく名前。「人を増やさない（2）」のように、まだ使っていない番号を付ける */
export function copyNameOf(name: string, others: string[]): string {
  // 「A（2）」や「A (2)」を複製したときは「A（2）（2）」ではなく「A（3）」にする
  const base = name.trim().replace(/\s*(（\d+）|\(\d+\))$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${base}（${n}）`;
    if (!others.some((o) => nameKey(o) === nameKey(candidate))) return candidate;
  }
}

/**
 * 表の見出しで足す施策の変更。source（複製元の施策の名前）があれば、その値と説明を写す。
 * 値のない施策も送る（サーバーは受け付け、「何もしない場合」と同じ結果の列になる）。名前が使えなければ例外を投げる
 */
export function newScenarioPatchOf(model: ModelJSON, name: string, source?: string): ScenarioPatch {
  const problem = scenarioNameProblem(name, (model.scenarios ?? []).map(scenarioName));
  if (problem) throw new Error(problem);
  const from = source === undefined ? undefined : findScenario(model, source);
  if (source !== undefined && !from) throw new Error(`複製する施策「${source}」が見つかりません。ほかのところ（AI など）で名前が変わったか、消された可能性があります。`);
  const patch: ScenarioPatch = { name: name.trim(), values: { ...(from?.values ?? {}) } };
  // 説明は、施策の編集欄と同じく、空でなければ送る
  const description = from?.description?.trim();
  if (description) patch.description = description;
  return patch;
}

// ここから、施策の中身の表で、行（変える値）を足す・消すときの計算

/** 表に足せる値。施策で値を変えられる要素のうち、まだ行にないもの（モデルの並び順） */
export function addableValues(model: ModelJSON, rows: MatrixRow[]): ModelElement[] {
  const shown = new Set(rows.map((r) => nameKey(r.element)));
  return valueTargets(model).filter((e) => !shown.has(nameKey(e.name!)));
}

/**
 * 行を消すときの変更。その値を変えている施策ごとに値を null にする（すべての施策でその値を変えない）。
 * 重ねていない施策（実行できなかった・色が足りない）も含める。1 回の保存で送ると、元に戻すも 1 回で済む。変えている施策がなければ空
 */
export function clearValuePatches(model: ModelJSON, element: string): ScenarioPatch[] {
  return (model.scenarios ?? []).flatMap((s, i) => {
    const keys = Object.keys(s.values).filter((k) => nameKey(k) === nameKey(element));
    return keys.length ? [{ name: scenarioName(s, i), values: Object.fromEntries(keys.map((k) => [k, null])) }] : [];
  });
}
