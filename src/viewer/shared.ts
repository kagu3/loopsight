import { checkActualData, namesByElement, parseDataCSV, renamesSince } from "../core/data.js";
import { toGraph } from "../core/diagram.js";
import { hasBaselinePatch, removeElements, setAnnotations, setScenarios, setSimulation, upsertElements, type AnnotationPatch, type EditReport, type RemoveTarget, type ScenarioReport } from "../core/edit.js";
import { setGroups, type GroupReport } from "../core/groups.js";
import type { ModelElement, ModelJSON } from "../core/modeljson.js";
import { runScenarios, type RunData } from "../core/simulate.js";
import { ModelError, validateModel } from "../core/validate.js";
import type { ActualDataResult, EditRequest, GroupsRequest, ModelResponse, RemoveRequest, RunResult, ScenarioRunResult, ScenariosRequest, SimulationRequest } from "./api.js";

// ビューアのサーバー（server.ts）と、デモサイト（web/src/demo）で同じになる処理。
// モデルを実行して ModelResponse を作ることと、画面からの書き込みを確かめてモデルに当てること。
// デモはブラウザの中で動くので、ここでは Node.js の API（node:fs など）を使わない（tests/viewer-shared.test.ts で確かめる）。
// ファイルの読み書きと、版（ハッシュ）の計算は、使う側がする

/** 書き込みの要求がおかしいとき。status はサーバーが返す番号（400 など） */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 画面からの書き込みの種類（POST /api/models/:name/<種類>） */
export type WriteAction = "edit" | "scenarios" | "groups" | "simulation" | "remove" | "undo";

/** 元に戻せる回数の上限（モデルごと） */
export const HISTORY_LIMIT = 50;

/**
 * 元に戻すための記録。before は書き込む前の中身、after は書き込んだあとの版。
 * renamed は変えた要素の名前（実際のデータの列名も戻すため）
 */
export interface HistoryEntry {
  before: string;
  after: string;
  renamed: [string, string][];
}

/** 記録を足す。上限を超えたら古いものから捨てる */
export function pushHistory(hist: HistoryEntry[], entry: HistoryEntry): void {
  hist.push(entry);
  if (hist.length > HISTORY_LIMIT) hist.shift();
}

/** 保存するときの中身（ModelJSON をファイルに書く形） */
export const modelText = (model: ModelJSON) => JSON.stringify(model, null, 2) + "\n";

/** 数値にできない値（単位つきの値など）は null にする */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v && typeof v === "object" && "value" in v && typeof (v as { value: unknown }).value === "number") {
    return (v as { value: number }).value;
  }
  return null;
}

/** 画面で重ねられるシナリオの数（web/src/Chart.tsx の MAX_SERIES）。これより後のシナリオは実行しない */
const MAX_SCENARIOS = 8;

function seriesOf(data: RunData): RunResult["series"] {
  const series: RunResult["series"] = {};
  for (const [k, values] of data.columns) series[k] = values.map(toNumber);
  return series;
}

/** モデルを確かめて実行し、画面に返す形にする。actual は実際のデータ（あるときだけ） */
export function buildModelResponse(args: {
  name: string;
  modified: string;
  version: string;
  undoAvailable: number;
  model: ModelJSON;
  actual?: ActualDataResult;
}): ModelResponse {
  const { name, modified, version, undoAvailable, model } = args;
  const validation = validateModel(model, { trialRun: false });
  const res: ModelResponse = { name, modified, version, undo_available: undoAvailable, model, validation };
  if (validation.ok) {
    try {
      // 何も変えない実行と、保存したシナリオをまとめて実行する
      const { baseline, scenarios } = runScenarios(model, { limit: MAX_SCENARIOS });
      res.run = { time_units: baseline.timeUnits, times: baseline.times, series: seriesOf(baseline) };
      if (scenarios.length) {
        res.scenarios = scenarios.map((s) => {
          const out: ScenarioRunResult = { name: s.name, values: s.overrides };
          if (s.description) out.description = s.description;
          if (s.skipped) out.skipped = true;
          else if (s.data) out.series = seriesOf(s.data);
          else out.error = s.error?.message ?? "実行できませんでした。";
          return out;
        });
      }
    } catch (e) {
      const err = e instanceof ModelError ? e : new ModelError((e as Error).message, []);
      res.run_error = { message: err.message, issues: err.issues };
    }
  }
  if (args.actual) res.actual = args.actual;
  return res;
}

/** 実際のデータ（CSV の中身）を読み、要素に合う列だけを要素名で返す。file はファイル名、version は中身の版 */
export function actualDataResult(model: ModelJSON, text: string, file: string, version: string): ActualDataResult {
  const res: ActualDataResult = { file, version, times: [], series: {}, issues: [] };
  try {
    const data = parseDataCSV(text);
    res.issues = checkActualData(model, data);
    res.times = data.times;
    const names = new Set(model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!));
    for (const c of data.columns) if (names.has(c.name)) res.series[c.name] = c.values;
  } catch (e) {
    res.issues = [{ message: `実際のデータ（${file}）を読めません: ${(e as Error).message}` }];
  }
  return res;
}

/** 同じ場所に来た雲をずらす距離（図の雲の幅ほど） */
const CLOUD_SHIFT = 40;

/**
 * ストックなどを消して端が空（モデルの外）になったフローの雲を、消した要素のあった場所に置く。
 * 端の座標がないと、図が仮の並べ方になってしまうため。removeElements の前に呼び、返した関数を後で呼ぶ。
 * 同じ場所に 2 つ以上の雲が来るとき（ストックに出入りするフローがあったとき）は、重ならないよう、
 * それぞれのフローの向きに沿って、もう一方の端の側へ雲の幅ほどずらす
 */
function keepCloudsInPlace(model: ModelJSON): () => void {
  // 箱と雲の中心（座標のない要素は、図と同じ仮の並べ方の位置）
  const centers = new Map<string, [number, number]>();
  const clouds = new Map<string, [number, number]>();
  for (const n of toGraph(model).nodes) {
    const c: [number, number] = [n.x + n.width / 2, n.y + n.height / 2];
    if (n.cloudOf) clouds.set(`${n.cloudOf.flow.toLowerCase()}:${n.cloudOf.end}`, c);
    else if (n.element && n.kind !== "VALVE") centers.set(n.element.toLowerCase(), c);
  }
  /** フローの端の中心（つながる先の箱か、雲） */
  const endCenter = (el: ModelElement, end: "from" | "to", name: string | null | undefined) =>
    (name ? centers.get(name.toLowerCase()) : undefined) ?? clouds.get(`${el.name!.toLowerCase()}:${end}`);
  const ends = model.elements.filter((e) => e.type === "FLOW").map((el) => ({ el, from: el.from, to: el.to }));
  return () => {
    const placed: { el: ModelElement; end: "from" | "to"; at: [number, number]; toward?: [number, number] }[] = [];
    for (const { el, ...before } of ends) {
      if (!model.elements.includes(el)) continue;
      for (const end of ["from", "to"] as const) {
        const at = before[end] && el[end] === null ? centers.get(before[end]!.toLowerCase()) : undefined;
        const other = end === "from" ? "to" : "from";
        if (at) placed.push({ el, end, at, toward: endCenter(el, other, before[other]) });
      }
    }
    for (const p of placed) {
      let [x, y] = p.at;
      // 同じ消した要素の中心（同じ配列）に置く雲がほかにもあるか
      const shared = placed.filter((q) => q.at === p.at).length > 1;
      if (shared && p.toward) {
        const [dx, dy] = [p.toward[0] - x, p.toward[1] - y];
        const len = Math.hypot(dx, dy);
        if (len > 0) [x, y] = [x + (dx / len) * CLOUD_SHIFT, y + (dy / len) * CLOUD_SHIFT];
      }
      p.el.display = { ...p.el.display, [`${p.end}_coordinates`]: [Math.round(x), Math.round(y)] };
    }
  };
}

const emptyEditReport = (): EditReport => ({ added: [], updated: [], removed: [], auto_links: [], notes: [] });

/** 注釈の変更の結果を、要素の編集の結果に足す（画面は要素の編集と同じ形で受け取る） */
function addAnnotationReport(report: EditReport, notes: { added: string[]; updated: string[]; removed: string[] }): void {
  report.added.push(...notes.added.map((id) => `注釈 "${id}"`));
  report.updated.push(...notes.updated.map((id) => `注釈 "${id}"`));
  report.removed.push(...notes.removed.map((id) => `注釈 "${id}"`));
}

/** 編集の要求の annotations（なければ空） */
function checkAnnotationPatches(value: unknown): AnnotationPatch[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((a) => a && typeof a === "object" && !Array.isArray(a))) {
    throw new RequestError(400, "annotations の中身は注釈の変更（オブジェクト）にしてください。");
  }
  return value as AnnotationPatch[];
}

/** 書き込みの要求の本文（どの種類の書き込みも、この形のどれかの項目を使う） */
export type WriteBody = EditRequest & ScenariosRequest & GroupsRequest & SimulationRequest & RemoveRequest;

/** 書き込みを当てた結果。renamed は名前の変わった要素の [前の名前, 新しい名前] */
export interface AppliedWrite {
  report?: EditReport | ScenarioReport | GroupReport;
  renamed: [string, string][];
}

/**
 * 画面からの書き込み（元に戻す、のほか）を確かめて、model に当てる（model を書き換える）。
 * MCP の upsert_elements、remove_elements、set_scenarios、set_groups、set_annotations、set_simulation と同じ処理を通す。
 * 要求がおかしければ RequestError、モデルに当てられなければ EditError などを投げる。版の確かめと保存は、使う側がする
 */
export function applyWrite(model: ModelJSON, action: Exclude<WriteAction, "undo">, body: WriteBody): AppliedWrite {
  if (action === "edit") {
    const notes = checkAnnotationPatches(body.annotations);
    if (!Array.isArray(body.elements) || (body.elements.length === 0 && !notes.length)) throw new RequestError(400, "elements がありません。");
    if (!body.elements.every((e) => e && typeof e === "object" && !Array.isArray(e))) throw new RequestError(400, "elements の中身は要素の変更（オブジェクト）にしてください。");
    const names = namesByElement(model);
    const report = body.elements.length ? upsertElements(model, body.elements) : emptyEditReport();
    if (notes.length) addAnnotationReport(report, setAnnotations(model, notes));
    return { report, renamed: renamesSince(model, names) };
  }
  if (action === "scenarios") {
    if (!Array.isArray(body.scenarios)) throw new RequestError(400, "scenarios がありません。");
    if (!body.scenarios.every((s) => s && typeof s === "object" && !Array.isArray(s) && typeof s.name === "string")) {
      throw new RequestError(400, "scenarios の中身は、name のあるシナリオの変更（オブジェクト）にしてください。");
    }
    if (body.remove !== undefined && !(Array.isArray(body.remove) && body.remove.every((r) => typeof r === "string"))) {
      throw new RequestError(400, "remove は消すシナリオの名前の並びにしてください。");
    }
    const baseline = body.baseline;
    if (baseline !== undefined) {
      const text = (v: unknown) => v === undefined || v === null || typeof v === "string";
      if (!baseline || typeof baseline !== "object" || Array.isArray(baseline) || !text(baseline.name) || !text(baseline.description)) {
        throw new RequestError(400, "baseline は、name と description（文字か null）のオブジェクトにしてください。");
      }
    }
    if (body.scenarios.length === 0 && !body.remove?.length && !hasBaselinePatch(baseline)) throw new RequestError(400, "scenarios か remove か baseline を指定してください。");
    return { report: setScenarios(model, body.scenarios, { remove: body.remove, baseline }), renamed: [] };
  }
  if (action === "groups") {
    if (!Array.isArray(body.groups)) throw new RequestError(400, "groups がありません。");
    if (!body.groups.every((g) => g && typeof g === "object" && !Array.isArray(g) && typeof g.name === "string")) {
      throw new RequestError(400, "groups の中身は、name のあるグループの変更（オブジェクト）にしてください。");
    }
    const names = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((n) => typeof n === "string"));
    const text = (v: unknown) => v === undefined || typeof v === "string";
    if (!body.groups.every((g) => names(g.elements) && names(g.add_elements) && names(g.remove_elements) && text(g.rename_to) && text(g.color))) {
      throw new RequestError(400, "elements・add_elements・remove_elements は要素の名前の並び、rename_to と color は文字にしてください。");
    }
    if (body.remove !== undefined && !(Array.isArray(body.remove) && body.remove.every((r) => typeof r === "string"))) {
      throw new RequestError(400, "remove は消すグループの名前の並びにしてください。");
    }
    if (body.groups.length === 0 && !body.remove?.length) throw new RequestError(400, "groups か remove を指定してください。");
    return { report: setGroups(model, body.groups, { remove: body.remove }), renamed: [] };
  }
  if (action === "simulation") {
    const sim = body.simulation as Record<string, unknown> | undefined;
    if (!sim || typeof sim !== "object" || Array.isArray(sim)) throw new RequestError(400, "simulation がありません。");
    const keys = ["time_start", "time_length", "time_step", "algorithm", "time_units"];
    if (!Object.keys(sim).length || !Object.keys(sim).every((k) => keys.includes(k))) throw new RequestError(400, `simulation には ${keys.join("・")} のどれかを指定してください。`);
    const num = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v));
    if (!num(sim.time_start) || !num(sim.time_length) || !num(sim.time_step)) throw new RequestError(400, "time_start・time_length・time_step は数にしてください。");
    // 解法と時間の単位の値は setSimulation が確かめる（MCP の set_simulation と同じ文で断る）
    setSimulation(model, body.simulation);
    return { renamed: [] };
  }
  const targets: RemoveTarget[] = body.elements;
  const notes = body.annotations ?? [];
  if (!Array.isArray(notes) || !notes.every((id) => typeof id === "string")) throw new RequestError(400, "annotations は消す注釈の id の並びにしてください。");
  if (!Array.isArray(targets) || (targets.length === 0 && !notes.length)) throw new RequestError(400, "elements がありません。");
  const named = (t: RemoveTarget) => typeof t.name === "string" || (typeof t.from === "string" && typeof t.to === "string");
  if (!targets.every((t) => t && typeof t === "object" && !Array.isArray(t) && named(t))) {
    throw new RequestError(400, "elements の中身は、消す要素の name（LINK なら from と to）にしてください。");
  }
  // つながるフローは残して端を雲にする（MCP の remove_elements の既定と同じ）。雲は消した要素のあった場所に置く
  const placeClouds = keepCloudsInPlace(model);
  const report = targets.length ? removeElements(model, targets) : emptyEditReport();
  placeClouds();
  if (notes.length) addAnnotationReport(report, setAnnotations(model, [], { remove: notes }));
  return { report, renamed: [] };
}

/** 書き込みの応答に添える文（版が合わないとき・元に戻せないとき）。サーバーとデモで同じ文にする */
export const CONFLICT_MESSAGE = "ほかのところ（AI など）で先にモデルが変わっていたため、書き込みませんでした。最新の内容を読み直しました。";
export const UNDO_CONFLICT_MESSAGE = "画面で変えたあとに、ほかのところ（AI など）でモデルが変わったため、元に戻せません。";
export const NOTHING_TO_UNDO = "元に戻せる変更がありません。";
