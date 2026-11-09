// シナリオを重ねて比べるときと、画面でシナリオを直すときの、React に依存しない計算。
import type { BaselinePatch, Equation, ModelElement, ModelJSON, RunResult, Scenario, ScenarioPatch, ScenarioRunResult } from "../../src/viewer/api.js";
import { baselineOf, DEFAULT_BASELINE_NAME } from "../../src/core/modeljson.js";
import { halfWidthEquation, parseEquation } from "./editing.js";

// 何も変えない実行の名前と説明は、モデルの baseline（サーバーと同じ baselineOf で読む。名前がなければ「いまのまま」）

/** グラフに重ねる実行 1 つ分。baseline は何も変えない実行 */
export interface CompareRun {
  name: string;
  description?: string;
  values: Record<string, Equation>;
  series: Record<string, (number | null)[]>;
  baseline: boolean;
}

export interface CompareRuns {
  /** 先頭が何も変えない実行。続けて、実行できたシナリオをモデルの並び順で */
  runs: CompareRun[];
  /** 実行できなかったシナリオ */
  failed: { name: string; error: string }[];
  /** 色が足りないため出さないシナリオ */
  omitted: string[];
}

/** 何も変えない実行（名前と説明は baseline。baselineOf の結果）とシナリオを、重ねて出す順に並べる。シナリオは色の数（max）まで */
export function compareRuns(run: RunResult, scenarios: ScenarioRunResult[], max: number, baseline: { name: string; description?: string }): CompareRuns {
  const out: CompareRuns = {
    runs: [{ name: baseline.name, ...(baseline.description ? { description: baseline.description } : {}), values: {}, series: run.series, baseline: true }],
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

/** シナリオの説明（凡例にカーソルを乗せたときに出す）。説明と、変える値 */
export function describeRun(r: CompareRun): string {
  if (r.baseline) return [r.description, "モデルの値を何も変えずに実行した結果です"].filter(Boolean).join("\n");
  const values = Object.entries(r.values).map(([k, v]) => `${k} = ${String(v)}`);
  return [r.description, values.length ? `変える値：${values.join("、")}` : "値を変えていません"].filter(Boolean).join("\n");
}

// ここから、シナリオの凡例を開いたときの表（シナリオの中身）の計算。列は compareRuns の runs と同じ並び

/** 数として読める値なら数。式（数でない文字）なら undefined */
export function numberOf(v: Equation | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

const MINUS = "−";

/**
 * 何も変えない実行の値から、シナリオの値への変化の添え書き。
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
  /** シナリオで値を変えたか（何も変えない実行の列はいつも false） */
  changed: boolean;
  /** 何も変えない実行からの変化（+50% など）。式のときや変えていないときは空文字 */
  change: string;
}

/** 変えた値の行。cells は runs と同じ並び（先頭が何も変えない実行） */
export interface MatrixRow {
  element: string;
  /** ストックの行（何も変えない実行の値は初期値） */
  initial: boolean;
  cells: MatrixCell[];
}

/**
 * 変えた値の行。どれかのシナリオで変えた要素だけを、モデルの並び順で（モデルにない要素は最後に）。
 * added（表で足した行の要素）は、どのシナリオでも変えていなくても出す（シナリオで値を変えられない要素や、モデルにない要素は出さない）。
 * 何も変えない実行の列はいまの値（ストックは初期値、変数とフローは式）
 */
export function valueRows(model: ModelJSON, runs: CompareRun[], added: string[] = []): MatrixRow[] {
  const scenarios = runs.filter((r) => !r.baseline);
  // シナリオの値は、要素名の大文字と小文字を区別せずに引く
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

/** 結果の行。cells は runs と同じ並び。シナリオの列の change は何も変えない実行からの変化 */
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

// ここから、シナリオを直すとき（表の見出しの吹き出しと、左の欄の説明）の計算。送る変更は MCP の set_scenarios と同じ形にする

/** 名前は大文字と小文字、前後の空白を区別しない（サーバーの sameName と同じ） */
export const nameKey = (name: string) => name.trim().toLowerCase();

/** シナリオの名前。名前のないシナリオは、サーバーと同じく「scenario 1」のように呼ぶ */
export const scenarioName = (s: Scenario, i: number) => s.name ?? `scenario ${i + 1}`;

/** モデルに保存したシナリオを名前で探す */
export function findScenario(model: ModelJSON, name: string): Scenario | undefined {
  return (model.scenarios ?? []).find((s, i) => nameKey(scenarioName(s, i)) === nameKey(name));
}

/** シナリオで値を変えられる要素の種類。画面で選べるのはストック・変数・フロー */
const VALUE_TYPES = new Set<ModelElement["type"]>(["STOCK", "VARIABLE", "FLOW"]);

/** シナリオで値を変えられる要素（モデルの並び順） */
export function valueTargets(model: ModelJSON): ModelElement[] {
  return model.elements.filter((e) => e.name && VALUE_TYPES.has(e.type));
}

/** いまのモデルの値（何も変えない実行）。ストックは初期値、変数とフローは式。要素がなければ undefined */
export function currentValueOf(model: ModelJSON, name: string): string | undefined {
  const el = model.elements.find((e) => e.type !== "LINK" && e.name && nameKey(e.name) === nameKey(name));
  const v = el?.type === "STOCK" ? el.behavior?.initial_value : el?.behavior?.value;
  return v === undefined ? undefined : String(v);
}

/**
 * シナリオの名前に使えない理由。空、何も変えない実行の名前（baseline）、ほかのシナリオ（others）と同じ名前。使えれば undefined。
 * 比べ方はサーバーの setScenarios と同じ（大文字と小文字、前後の空白を区別しない）
 */
export function scenarioNameProblem(name: string, others: string[], baseline: string): string | undefined {
  const n = name.trim();
  if (!n) return "シナリオの名前が空です。";
  if (nameKey(n) === nameKey(baseline)) return `「${baseline}」は何も変えない実行の名前なので、シナリオには使えません。`;
  if (others.some((o) => nameKey(o) === nameKey(n))) return `「${n}」という名前のシナリオがすでにあります。`;
  return undefined;
}

/**
 * 表の見出しの吹き出しで、シナリオの名前を変えるときの変更。名前が同じなら（何も変えていなければ）undefined。
 * 大文字と小文字だけを変えるときも送る。名前が使えない・シナリオが見つからなければ例外を投げる
 */
export function renamePatchOf(model: ModelJSON, name: string, text: string): ScenarioPatch | undefined {
  const scenarios = model.scenarios ?? [];
  const s = findScenario(model, name);
  if (!s) throw new Error(`シナリオ「${name}」が見つかりません。ほかのところ（AI など）で名前が変わったか、消された可能性があります。`);
  const original = scenarioName(s, scenarios.indexOf(s));
  const next = text.trim();
  if (next === original) return undefined;
  const others = scenarios.map(scenarioName).filter((_, i) => scenarios[i] !== s);
  const problem = scenarioNameProblem(next, others, baselineOf(model).name);
  if (problem) throw new Error(problem);
  return { name: original, rename_to: next };
}

/**
 * 表の見出しの吹き出しで、何も変えない実行の名前を変えるときの変更（MCP の set_scenarios の baseline と同じ形）。
 * 名前が同じなら undefined。空にしたら、既定の名前（いまのまま）に戻す（null）。シナリオと同じ名前なら例外を投げる
 */
export function baselineRenamePatchOf(model: ModelJSON, text: string): BaselinePatch | undefined {
  const current = baselineOf(model).name;
  const next = text.trim() || DEFAULT_BASELINE_NAME;
  if (next === current) return undefined;
  const scenarios = model.scenarios ?? [];
  if (scenarios.some((s, i) => nameKey(scenarioName(s, i)) === nameKey(next)) && nameKey(next) !== nameKey(current)) {
    throw new Error(`「${next}」という名前のシナリオがあるので、何も変えない実行の名前には使えません。`);
  }
  return { name: next === DEFAULT_BASELINE_NAME ? null : next };
}

/** 何も変えない実行の説明（左の欄）。直していなければ undefined。空にしたら説明を消す（null） */
export function baselineDescriptionPatchOf(before: string, after: string): BaselinePatch | undefined {
  const description = after.trim();
  if (description === before.trim()) return undefined;
  return { description: description || null };
}

/**
 * 左の欄で説明を保存したあと、欄を保存した中身で作り直すか。waiting は保存の結果を待っているか、base は編集を始めたときの説明、
 * latest はいまのモデルの説明。保存する前の版（latest が base のまま）で描き直したときは、まだ待つ（欄を古い説明に戻さない）。
 * 新しい版が来たら reset にその説明を返し、待つのをやめる
 */
export function descriptionAfterSave(waiting: boolean, base: string, latest: string): { waiting: boolean; reset?: string } {
  if (!waiting || latest === base) return { waiting };
  return { waiting: false, reset: latest };
}

/** シナリオの説明（左の欄）。直していなければ undefined。空にしたら説明を消す（null） */
export function descriptionPatchOf(name: string, before: string, after: string): ScenarioPatch | undefined {
  const description = after.trim();
  if (description === before.trim()) return undefined;
  return { name, description: description || null };
}

// ここから、シナリオに注目している間（凡例にカーソルを乗せている・左の欄で直している）に、図の変えた要素に付ける札の計算

/** 図の札 1 つ分 */
export interface ScenarioBadge {
  /** 要素の名前（モデルの表記） */
  element: string;
  /** ストック（いまの値・シナリオの値は初期値） */
  initial: boolean;
  /** いまの値（何も変えない実行）。値のない要素なら空文字 */
  current: string;
  /** シナリオの値 */
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
 * シナリオで変えた要素の札。要素名（nameKey）→ 札。
 * 値はシナリオに保存してある値（表のマスで入れている途中の値ではない）。モデルにない要素は図に出ないので除く
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
    const title = [`${el.name}${initial ? "の初期値" : ""}`, `いまの値：${current.trim() || "—"}`, `シナリオの値：${value}`].join("\n");
    out.set(nameKey(el.name), { element: el.name, initial, current, value, text, title });
  }
  return out;
}

// ここから、シナリオの中身の表のマスで、シナリオの値をその場で直すときの計算。送る変更は MCP の set_scenarios と同じ形（値 1 つだけ）

/** シナリオに保存してある要素の値（書き方のまま）。シナリオがないか、その値を変えていなければ undefined */
export function scenarioValueOf(model: ModelJSON, scenario: string, element: string): string | undefined {
  const v = Object.entries(findScenario(model, scenario)?.values ?? {}).find(([k]) => nameKey(k) === nameKey(element))?.[1];
  return v === undefined ? undefined : String(v);
}

/** 表のマスで直せる値か。モデルにあり、シナリオで値を変えられる要素（ストック・変数・フロー）だけ。ほかは保存できない */
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
 * 空なら、そのシナリオではその値を変えない（null。何も変えない実行と同じ値に戻る）。全角の数字と記号は半角にする。
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

// ここから、シナリオの中身の表の見出しで、シナリオを足す・複製するときの計算。送る変更は MCP の set_scenarios と同じ形

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
 * 表の見出しで足すシナリオの変更。source（複製元のシナリオの名前）があれば、その値と説明を写す。
 * 値のないシナリオも送る（サーバーは受け付け、何も変えない実行と同じ結果の列になる）。名前が使えなければ例外を投げる
 */
export function newScenarioPatchOf(model: ModelJSON, name: string, source?: string): ScenarioPatch {
  const problem = scenarioNameProblem(name, (model.scenarios ?? []).map(scenarioName), baselineOf(model).name);
  if (problem) throw new Error(problem);
  const from = source === undefined ? undefined : findScenario(model, source);
  if (source !== undefined && !from) throw new Error(`複製するシナリオ「${source}」が見つかりません。ほかのところ（AI など）で名前が変わったか、消された可能性があります。`);
  const patch: ScenarioPatch = { name: name.trim(), values: { ...(from?.values ?? {}) } };
  // 説明は、空でなければ送る
  const description = from?.description?.trim();
  if (description) patch.description = description;
  return patch;
}

// ここから、シナリオの中身の表で、行（変える値）を足す・消すときの計算

/** 表に足せる値。シナリオで値を変えられる要素のうち、まだ行にないもの（モデルの並び順） */
export function addableValues(model: ModelJSON, rows: MatrixRow[]): ModelElement[] {
  const shown = new Set(rows.map((r) => nameKey(r.element)));
  return valueTargets(model).filter((e) => !shown.has(nameKey(e.name!)));
}

/**
 * 行を消すときの変更。その値を変えているシナリオごとに値を null にする（すべてのシナリオでその値を変えない）。
 * 重ねていないシナリオ（実行できなかった・色が足りない）も含める。1 回の保存で送ると、元に戻すも 1 回で済む。変えているシナリオがなければ空
 */
export function clearValuePatches(model: ModelJSON, element: string): ScenarioPatch[] {
  return (model.scenarios ?? []).flatMap((s, i) => {
    const keys = Object.keys(s.values).filter((k) => nameKey(k) === nameKey(element));
    return keys.length ? [{ name: scenarioName(s, i), values: Object.fromEntries(keys.map((k) => [k, null])) }] : [];
  });
}
