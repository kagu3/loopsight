import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import {
  EditError,
  ModelError,
  ModelStore,
  StoreError,
  checkActualData,
  checkModelName,
  namesByElement,
  parseDataCSV,
  removeElements,
  renamesSince,
  runScenarios,
  setAnnotations,
  setGroups,
  setScenarios,
  toGraph,
  upsertElements,
  validateModel,
  versionOf,
  type EditReport,
  type ModelElement,
  type ModelJSON,
  type RemoveTarget,
  type RunData,
} from "../core/index.js";
import {
  VIEWER_HEADER,
  type ActualDataResult,
  type AnnotationPatch,
  type ChangeEvent,
  type DiagramExportRequest,
  type DiagramExportResponse,
  type EditErrorResponse,
  type EditRequest,
  type EditResponse,
  type GroupsRequest,
  type ModelListResponse,
  type ModelResponse,
  type RemoveRequest,
  type RunResult,
  type ScenarioRunResult,
  type ScenariosRequest,
  type UndoRequest,
} from "./api.js";
import { DIAGRAM_FILE_BASE, exportFolderOf, writeDiagramImages } from "./diagram-export.js";
import { watchTree } from "./watch.js";

// ビューア（Web 画面）のサーバー。作業フォルダの ModelJSON を読んで返し、変更を Server-Sent Events で知らせる。
// 画面からの編集も受け付け、同じファイルに書き戻す（MCP の upsert_elements、remove_elements、set_scenarios、set_groups、set_annotations と同じ処理を通す）。
// 127.0.0.1 だけで待ち受け、Host ヘッダーも確かめる（DNS リバインディングで別のサイトから読まれないように）。
// 書き込みには、さらに Origin と独自のヘッダーを求める（ほかのサイトから送れないように）。
// 画面の図を書き出した画像（SVG と PNG）も受け取り、作業フォルダの exports/<モデル名>/ に書く（MCP の export_diagram と同じ書き出し先）。

export interface ViewerOptions {
  /** 作業フォルダ */
  modelsDir: string;
  /** ビルドした画面（index.html のあるフォルダ）。なければ API だけ */
  staticDir?: string;
  /** 待ち受けるポート。0 なら空いているポート */
  port?: number;
}

export interface Viewer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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

async function loadModelResponse(store: ModelStore, name: string, undoAvailable = 0): Promise<ModelResponse> {
  const { model, version } = await store.readVersioned(name);
  return modelResponse(store, name, model, version, undoAvailable);
}

async function modelResponse(store: ModelStore, name: string, model: ModelJSON, version: string, undoAvailable: number): Promise<ModelResponse> {
  const modified = (await stat(store.pathOf(name))).mtime.toISOString();
  const validation = validateModel(model, { trialRun: false });
  const res: ModelResponse = { name, modified, version, undo_available: undoAvailable, model, validation };
  if (validation.ok) {
    try {
      // 「元のモデル」と、保存したシナリオをまとめて実行する
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
  const actual = await actualData(store, name, model);
  if (actual) res.actual = actual;
  return res;
}

/** 実際のデータを読み、要素に合う列だけを要素名で返す。CSV がなければ undefined */
async function actualData(store: ModelStore, name: string, model: ModelJSON): Promise<ActualDataResult | undefined> {
  const text = await store.readData(name);
  if (text === undefined) return undefined;
  const res: ActualDataResult = { file: path.basename(store.dataPathOf(name)), version: versionOf(text), times: [], series: {}, issues: [] };
  try {
    const data = parseDataCSV(text);
    res.issues = checkActualData(model, data);
    res.times = data.times;
    const names = new Set(model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!));
    for (const c of data.columns) if (names.has(c.name)) res.series[c.name] = c.values;
  } catch (e) {
    res.issues = [{ message: `実際のデータ（${res.file}）を読めません: ${(e as Error).message}` }];
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
  const ends = model.elements.filter((e) => e.type === "FLOW" || e.type === "TRANSITION").map((el) => ({ el, from: el.from, to: el.to }));
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
/**
 * 元に戻すための記録。before は書き込む前の中身、after は書き込んだあとの版。
 * renamed は変えた要素の名前（実際のデータの列名も戻すため）
 */
interface HistoryEntry {
  before: string;
  after: string;
  renamed: [string, string][];
}
const HISTORY_LIMIT = 50;
const MAX_BODY = 1024 * 1024;
/** 図の画像（SVG と、base64 にした PNG）を受け取るときの上限 */
const MAX_IMAGE_BODY = 64 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
    throw new HttpError(400, "annotations の中身は注釈の変更（オブジェクト）にしてください。");
  }
  return value as AnnotationPatch[];
}

/** 書き込みの要求が、このビューアの画面から来たものか確かめる */
function checkWriteRequest(req: IncomingMessage): void {
  if (req.method !== "POST") throw new HttpError(405, "POST で送ってください。");
  if (req.headers[VIEWER_HEADER.toLowerCase()] !== "1") throw new HttpError(403, "ビューアの画面からしか書き込めません。");
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON で送ってください。");
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      // 読めない Origin は断る
    }
    if (!ALLOWED_HOSTS.has(host) && host !== "::1") throw new HttpError(403, "ほかのサイトからは書き込めません。");
  }
}

async function readBody<T>(req: IncomingMessage, limit = MAX_BODY): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "送る内容が大きすぎます。");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "JSON として読めません。");
  }
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  // 先に文字列にする（失敗したときにヘッダーだけ送った状態にしない）
  const text = JSON.stringify(body);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

export async function startViewer(options: ViewerOptions): Promise<Viewer> {
  const store = new ModelStore(options.modelsDir);
  const clients = new Set<ServerResponse>();

  // 作業フォルダの監視（サブフォルダの中も）。同じファイルの変更が続けて届くので、少し待ってからまとめて送る
  const pending = new Map<string, NodeJS.Timeout>();
  const send = (event: ChangeEvent) => {
    for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  /** key ごとに、最後の変更から少し待ってから task を動かす */
  const later = (key: string, task: () => Promise<void> | void) => {
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void task();
      }, 150),
    );
  };
  const notify = (file: string) => {
    // 先頭が . のファイルやフォルダ（.DS_Store、.git など）と、書き込みの途中の一時ファイルは見ない
    if (file.split("/").some((part) => part.startsWith(".")) || file.toLowerCase().endsWith(".tmp")) return;
    // 実際のデータ（<モデル名>.data.csv）が変わったら、そのモデルが変わったと知らせる。
    // 以前の筋書きのファイル（<モデル名>.slides.json）は、モデル名に使えない名前になるので知らせない
    const lower = file.toLowerCase();
    const suffix = lower.endsWith(".data.csv") ? ".data.csv" : undefined;
    if (!suffix && !lower.endsWith(".json")) {
      // フォルダを作った・消した・動かした（中のどのモデルが変わったかは分からない）か、モデルでないファイルが変わった。
      // 一覧に出すフォルダが変わったかもしれないので、一覧と開いているモデルを読み直してもらう
      later("", () => send({ type: "folders" }));
      return;
    }
    let name: string;
    try {
      name = checkModelName(suffix ? file.slice(0, -suffix.length) : file);
    } catch {
      return;
    }
    later(name, async () => {
      const st = await stat(store.pathOf(name)).catch(() => undefined);
      // 名前が .json で終わるフォルダは、モデルではない
      if (st?.isDirectory()) return send({ type: "folders" });
      // CSV だけがあってモデルがなければ、知らせない（モデルが消えたわけではない）
      if (suffix && !st) return;
      send({ type: st ? "changed" : "removed", name });
    });
  };
  // 作業フォルダがまだなければ作っておく（あとから AI がモデルを作っても気づけるように）
  await mkdir(store.dir, { recursive: true });
  const watcher = watchTree(store.dir, notify);

  // 画面からの書き込みの記録（モデル名 → 古い順）。メモリの中だけに持つ
  const history = new Map<string, HistoryEntry[]>();
  // 同じファイルを指す名前（"foo" と "foo.json"）は同じ記録にする。
  // 大文字と小文字は、ファイル名で区別しない Windows と macOS でだけ同じに扱う
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const keyOf = (name: string) => {
    let key = name;
    try {
      key = checkModelName(name);
    } catch {
      // 使えない名前は、そのまま（読み書きの前に断られる）
    }
    return caseInsensitive ? key.toLowerCase() : key;
  };
  const historyOf = (name: string) => {
    const key = keyOf(name);
    if (!history.has(key)) history.set(key, []);
    return history.get(key)!;
  };
  // 同じモデルへの書き込みは 1 つずつ（読んで、確かめて、書くあいだに割り込ませない）
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const key = keyOf(name);
    const run = (locks.get(key) ?? Promise.resolve()).then(task, task);
    locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  };

  const conflict = async (name: string, message: string): Promise<EditErrorResponse> => ({
    error: message,
    conflict: true,
    current: await loadModelResponse(store, name, historyOf(name).length),
  });

  const handleWrite = async (req: IncomingMessage, res: ServerResponse, name: string, action: "edit" | "scenarios" | "groups" | "remove" | "undo") => {
    try {
      checkWriteRequest(req);
      const body = await readBody<EditRequest & ScenariosRequest & GroupsRequest & RemoveRequest & UndoRequest>(req);
      if (typeof body?.version !== "string") throw new HttpError(400, "version がありません。");
      const result = await serial(name, async (): Promise<[number, EditResponse | EditErrorResponse]> => {
        const current = await store.readVersioned(name);
        const hist = historyOf(name);
        if (current.version !== body.version) {
          return [409, await conflict(name, "ほかのところ（AI など）で先にモデルが変わっていたため、書き込みませんでした。最新の内容を読み直しました。")];
        }
        if (action === "edit") {
          const notes = checkAnnotationPatches(body.annotations);
          if (!Array.isArray(body.elements) || (body.elements.length === 0 && !notes.length)) throw new HttpError(400, "elements がありません。");
          if (!body.elements.every((e) => e && typeof e === "object" && !Array.isArray(e))) throw new HttpError(400, "elements の中身は要素の変更（オブジェクト）にしてください。");
          const names = namesByElement(current.model);
          const report = body.elements.length ? upsertElements(current.model, body.elements) : emptyEditReport();
          if (notes.length) addAnnotationReport(report, setAnnotations(current.model, notes));
          const version = await store.writeVersioned(name, current.model);
          const renamed = renamesSince(current.model, names);
          // 実際のデータの列名は、記録を残してから直す（直せなくても、保存したモデルは元に戻せるように）
          hist.push({ before: current.text, after: version, renamed });
          if (hist.length > HISTORY_LIMIT) hist.shift();
          const data = await store.renameDataColumns(name, renamed);
          if (data.note) report.notes.push(data.note);
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, { report, model, ...(data.warning ? { warning: data.warning } : {}), ...(renamed.length ? { renamed } : {}) }];
        }
        if (action === "scenarios") {
          if (!Array.isArray(body.scenarios)) throw new HttpError(400, "scenarios がありません。");
          if (!body.scenarios.every((s) => s && typeof s === "object" && !Array.isArray(s) && typeof s.name === "string")) {
            throw new HttpError(400, "scenarios の中身は、name のあるシナリオの変更（オブジェクト）にしてください。");
          }
          if (body.remove !== undefined && !(Array.isArray(body.remove) && body.remove.every((r) => typeof r === "string"))) {
            throw new HttpError(400, "remove は消すシナリオの名前の並びにしてください。");
          }
          if (body.scenarios.length === 0 && !body.remove?.length) throw new HttpError(400, "scenarios か remove を指定してください。");
          const report = setScenarios(current.model, body.scenarios, { remove: body.remove });
          const version = await store.writeVersioned(name, current.model);
          hist.push({ before: current.text, after: version, renamed: [] });
          if (hist.length > HISTORY_LIMIT) hist.shift();
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, { report, model }];
        }
        if (action === "groups") {
          if (!Array.isArray(body.groups)) throw new HttpError(400, "groups がありません。");
          if (!body.groups.every((g) => g && typeof g === "object" && !Array.isArray(g) && typeof g.name === "string")) {
            throw new HttpError(400, "groups の中身は、name のあるグループの変更（オブジェクト）にしてください。");
          }
          const names = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((n) => typeof n === "string"));
          const text = (v: unknown) => v === undefined || typeof v === "string";
          if (!body.groups.every((g) => names(g.elements) && names(g.add_elements) && names(g.remove_elements) && text(g.rename_to) && text(g.color))) {
            throw new HttpError(400, "elements・add_elements・remove_elements は要素の名前の並び、rename_to と color は文字にしてください。");
          }
          if (body.remove !== undefined && !(Array.isArray(body.remove) && body.remove.every((r) => typeof r === "string"))) {
            throw new HttpError(400, "remove は消すグループの名前の並びにしてください。");
          }
          if (body.groups.length === 0 && !body.remove?.length) throw new HttpError(400, "groups か remove を指定してください。");
          const report = setGroups(current.model, body.groups, { remove: body.remove });
          const version = await store.writeVersioned(name, current.model);
          hist.push({ before: current.text, after: version, renamed: [] });
          if (hist.length > HISTORY_LIMIT) hist.shift();
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, { report, model }];
        }
        if (action === "remove") {
          const targets: RemoveTarget[] = body.elements;
          const notes = body.annotations ?? [];
          if (!Array.isArray(notes) || !notes.every((id) => typeof id === "string")) throw new HttpError(400, "annotations は消す注釈の id の並びにしてください。");
          if (!Array.isArray(targets) || (targets.length === 0 && !notes.length)) throw new HttpError(400, "elements がありません。");
          const named = (t: RemoveTarget) => typeof t.name === "string" || (typeof t.from === "string" && typeof t.to === "string");
          if (!targets.every((t) => t && typeof t === "object" && !Array.isArray(t) && named(t))) {
            throw new HttpError(400, "elements の中身は、消す要素の name（LINK なら from と to）にしてください。");
          }
          // つながるフローは残して端を雲にする（MCP の remove_elements の既定と同じ）。雲は消した要素のあった場所に置く
          const placeClouds = keepCloudsInPlace(current.model);
          const report = targets.length ? removeElements(current.model, targets) : emptyEditReport();
          placeClouds();
          if (notes.length) addAnnotationReport(report, setAnnotations(current.model, [], { remove: notes }));
          const version = await store.writeVersioned(name, current.model);
          // 実際のデータの列はそのまま残す（合わなくなったところは「問題」に出る。元に戻せばまた合う）
          hist.push({ before: current.text, after: version, renamed: [] });
          if (hist.length > HISTORY_LIMIT) hist.shift();
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, { report, model }];
        }
        const last = hist.at(-1);
        if (!last) throw new HttpError(400, "元に戻せる変更がありません。");
        if (last.after !== current.version) {
          hist.length = 0;
          return [409, await conflict(name, "画面で変えたあとに、ほかのところ（AI など）でモデルが変わったため、元に戻せません。")];
        }
        hist.pop();
        await store.writeVersioned(name, { text: last.before });
        const back = last.renamed.map(([from, to]): [string, string] => [to, from]);
        const data = await store.renameDataColumns(name, back);
        const model = await loadModelResponse(store, name, hist.length);
        return [200, { model, ...(data.warning ? { warning: data.warning } : {}), ...(back.length ? { renamed: back } : {}) }];
      });
      sendJSON(res, result[0], result[1]);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof StoreError ? 404 : e instanceof EditError ? 400 : 500;
      sendJSON(res, status, { error: (e as Error).message } satisfies EditErrorResponse);
    }
  };

  /** 画面の図を書き出した画像を、exports/<モデル名>/diagram.svg と diagram.png に書く */
  const handleExportDiagram = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    try {
      checkWriteRequest(req);
      const body = await readBody<DiagramExportRequest>(req, MAX_IMAGE_BODY);
      if (typeof body?.svg !== "string" || !body.svg.startsWith("<svg")) throw new HttpError(400, "svg がありません。");
      if (typeof body.png !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.png)) throw new HttpError(400, "png（base64）がありません。");
      const png = Buffer.from(body.png, "base64");
      if (png.subarray(1, 4).toString("latin1") !== "PNG") throw new HttpError(400, "png が PNG の画像ではありません。");
      try {
        await store.read(name);
      } catch (e) {
        throw e instanceof StoreError ? new HttpError(404, e.message) : e;
      }
      const written = await writeDiagramImages(store, exportFolderOf(name), DIAGRAM_FILE_BASE, { svg: body.svg, png });
      sendJSON(res, 200, written satisfies DiagramExportResponse);
    } catch (e) {
      sendJSON(res, e instanceof HttpError ? e.status : 500, { error: (e as Error).message } satisfies EditErrorResponse);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!ALLOWED_HOSTS.has(host)) {
      sendJSON(res, 403, { error: "このサーバーは localhost からしか使えません。" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = decodeURIComponent(url.pathname);

    if (p === "/api/models") {
      const body: ModelListResponse = { dir: store.dir, ...(await store.tree()) };
      sendJSON(res, 200, body);
      return;
    }
    // モデル名はフォルダを含む（ブルックスの法則/brooks_law）。画面は名前を encodeURIComponent で送る（/ は %2F）が、/ のままでも読む。
    // 書き込みは、デコードする前のパスの終わりで見分ける（%2F で送られた名前の中の「/edit」などと取り違えないように）
    const exported = url.pathname.match(/^\/api\/models\/(.+)\/export-diagram$/);
    if (exported) {
      await handleExportDiagram(req, res, decodeURIComponent(exported[1]!));
      return;
    }
    const write = url.pathname.match(/^\/api\/models\/(.+)\/(edit|scenarios|groups|remove|undo)$/);
    if (write) {
      await handleWrite(req, res, decodeURIComponent(write[1]!), write[2] as "edit" | "scenarios" | "groups" | "remove" | "undo");
      return;
    }
    if (p.startsWith("/api/models/")) {
      try {
        const name = p.slice("/api/models/".length);
        sendJSON(res, 200, await loadModelResponse(store, name, historyOf(name).length));
      } catch (e) {
        sendJSON(res, e instanceof StoreError ? 404 : 500, { error: (e as Error).message });
      }
      return;
    }
    if (p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p.startsWith("/api/")) {
      sendJSON(res, 404, { error: "ありません。" });
      return;
    }
    await serveStatic(options.staticDir, p, res);
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((e) => sendJSON(res, 500, { error: (e as Error).message }));
  });
  // 接続を保ったままのクライアントがいても止まれるよう、定期的にコメントを送る
  const ping = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 30_000);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    server,
    url: `http://localhost:${port}/`,
    close: async () => {
      clearInterval(ping);
      watcher.close();
      for (const t of pending.values()) clearTimeout(t);
      for (const c of clients) c.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serveStatic(dir: string | undefined, p: string, res: ServerResponse): Promise<void> {
  if (!dir) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("画面がビルドされていません。npm run build を実行してください。");
    return;
  }
  const root = path.resolve(dir);
  let file = path.resolve(root, "." + p);
  if (path.relative(root, file).startsWith("..")) file = path.join(root, "index.html");
  let body: Buffer;
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    body = await readFile(file);
  } catch {
    // 画面の中のパス（#以外の遷移）は index.html に任せる
    file = path.join(root, "index.html");
    try {
      body = await readFile(file);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("画面がビルドされていません。npm run build を実行してください。");
      return;
    }
  }
  // ビルドのたびに名前が変わる assets/ の中は長く持たせ、index.html は毎回確かめさせる
  const cache = path.relative(root, file).startsWith("assets") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": cache });
  res.end(body);
}
