import { watch, type FSWatcher } from "node:fs";
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
  checkSlides,
  namesByElement,
  namesByScenario,
  parseDataCSV,
  parseSlides,
  removeElements,
  renamesSince,
  runScenarios,
  scenarioRenamesSince,
  setScenarios,
  toGraph,
  upsertElements,
  validateModel,
  versionOf,
  type ActualData,
  type ModelElement,
  type ModelJSON,
  type RemoveTarget,
  type RunData,
} from "../core/index.js";
import {
  VIEWER_HEADER,
  type ActualDataResult,
  type ChangeEvent,
  type EditErrorResponse,
  type EditRequest,
  type EditResponse,
  type ModelListResponse,
  type ModelResponse,
  type RemoveRequest,
  type RunResult,
  type ScenarioRunResult,
  type ScenariosRequest,
  type SlidesResult,
  type UndoRequest,
} from "./api.js";

// ビューア（Web 画面）のサーバー。作業フォルダの ModelJSON を読んで返し、変更を Server-Sent Events で知らせる。
// 画面からの編集も受け付け、同じファイルに書き戻す（MCP の upsert_elements、remove_elements、set_scenarios と同じ処理を通す）。
// 127.0.0.1 だけで待ち受け、Host ヘッダーも確かめる（DNS リバインディングで別のサイトから読まれないように）。
// 書き込みには、さらに Origin と独自のヘッダーを求める（ほかのサイトから送れないように）。

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

/** 画面で重ねられる施策の数（web/src/Chart.tsx の MAX_SERIES）。これより後の施策は実行しない */
const MAX_SCENARIOS = 8;

function seriesOf(data: RunData): RunResult["series"] {
  const series: RunResult["series"] = {};
  for (const [k, values] of data.columns) series[k] = values.map(toNumber);
  return series;
}

export async function loadModelResponse(store: ModelStore, name: string, undoAvailable = 0): Promise<ModelResponse> {
  const { model, version } = await store.readVersioned(name);
  return modelResponse(store, name, model, version, undoAvailable);
}

async function modelResponse(store: ModelStore, name: string, model: ModelJSON, version: string, undoAvailable: number): Promise<ModelResponse> {
  const modified = (await stat(store.pathOf(name))).mtime.toISOString();
  const validation = validateModel(model, { trialRun: false });
  const res: ModelResponse = { name, modified, version, undo_available: undoAvailable, model, validation };
  if (validation.ok) {
    try {
      // 「何もしない場合」と、保存したシナリオ（施策）をまとめて実行する
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
  if (actual) res.actual = actual.result;
  const slides = await slidesResult(store, name, model, actual?.data);
  if (slides) res.slides = slides;
  return res;
}

/** 実際のデータを読み、要素に合う列だけを要素名で返す。CSV がなければ undefined。data は読めたときの中身（筋書きの確認に使う） */
async function actualData(store: ModelStore, name: string, model: ModelJSON): Promise<{ result: ActualDataResult; data?: ActualData } | undefined> {
  const text = await store.readData(name);
  if (text === undefined) return undefined;
  const res: ActualDataResult = { file: path.basename(store.dataPathOf(name)), version: versionOf(text), times: [], series: {}, issues: [] };
  try {
    const data = parseDataCSV(text);
    res.issues = checkActualData(model, data);
    res.times = data.times;
    const names = new Set(model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!));
    for (const c of data.columns) if (names.has(c.name)) res.series[c.name] = c.values;
    return { result: res, data };
  } catch (e) {
    res.issues = [{ message: `実際のデータ（${res.file}）を読めません: ${(e as Error).message}` }];
    return { result: res };
  }
}

/** 会議資料の筋書きを読み、モデルに合うか確かめて返す。ファイルがなければ undefined */
async function slidesResult(store: ModelStore, name: string, model: ModelJSON, data: ActualData | undefined): Promise<SlidesResult | undefined> {
  const read = await store.readSlidesText(name);
  if (!read) return undefined;
  const res: SlidesResult = { file: path.basename(store.slidesPathOf(name)), version: read.version, issues: [] };
  try {
    const deck = parseSlides(read.text);
    const { errors, warnings } = checkSlides(model, deck, data);
    res.deck = deck;
    res.issues = [...errors, ...warnings];
  } catch (e) {
    res.issues = [{ slide: 0, message: `筋書き（${res.file}）を読めません: ${(e as Error).message}` }];
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
 * renamed は変えた要素の名前（実際のデータの列名と筋書きの中の名前も戻すため）、renamedScenarios は変えた施策の名前（筋書きの中の名前も戻すため）
 */
interface HistoryEntry {
  before: string;
  after: string;
  renamed: [string, string][];
  renamedScenarios: [string, string][];
}
const HISTORY_LIMIT = 50;
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "送る内容が大きすぎます。");
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

  // 作業フォルダの監視。同じファイルの変更が続けて届くので、少し待ってからまとめて送る
  const pending = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | undefined;
  const notify = (file: string) => {
    // 実際のデータ（<モデル名>.data.csv）や筋書き（<モデル名>.slides.json）が変わったら、そのモデルが変わったと知らせる
    const lower = file.toLowerCase();
    const suffix = [".data.csv", ".slides.json"].find((x) => lower.endsWith(x));
    if (!suffix && !lower.endsWith(".json")) return;
    const name = suffix ? file.slice(0, -suffix.length) : file.replace(/\.json$/i, "");
    clearTimeout(pending.get(name));
    pending.set(
      name,
      setTimeout(async () => {
        pending.delete(name);
        const exists = await stat(path.join(store.dir, suffix ? `${name}.json` : file)).then(
          () => true,
          () => false,
        );
        // CSV や筋書きだけがあってモデルがなければ、知らせない（モデルが消えたわけではない）
        if (suffix && !exists) return;
        const event: ChangeEvent = { type: exists ? "changed" : "removed", name };
        for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
      }, 150),
    );
  };
  // 作業フォルダがまだなければ作っておく（あとから AI がモデルを作っても気づけるように）
  await mkdir(store.dir, { recursive: true });
  watcher = watch(store.dir, (_event, file) => file && notify(file.toString()));
  // Windows では監視中のフォルダが消されると error が出る。拾わないとプロセスごと止まる
  watcher.on("error", (e) => console.error(`作業フォルダを監視できなくなりました: ${(e as Error).message}`));

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

  const handleWrite = async (req: IncomingMessage, res: ServerResponse, name: string, action: "edit" | "scenarios" | "remove" | "undo") => {
    try {
      checkWriteRequest(req);
      const body = await readBody<EditRequest & ScenariosRequest & RemoveRequest & UndoRequest>(req);
      if (typeof body?.version !== "string") throw new HttpError(400, "version がありません。");
      const result = await serial(name, async (): Promise<[number, EditResponse | EditErrorResponse]> => {
        const current = await store.readVersioned(name);
        const hist = historyOf(name);
        if (current.version !== body.version) {
          return [409, await conflict(name, "ほかのところ（AI など）で先にモデルが変わっていたため、書き込みませんでした。最新の内容を読み直しました。")];
        }
        if (action === "edit") {
          if (!Array.isArray(body.elements) || body.elements.length === 0) throw new HttpError(400, "elements がありません。");
          if (!body.elements.every((e) => e && typeof e === "object" && !Array.isArray(e))) throw new HttpError(400, "elements の中身は要素の変更（オブジェクト）にしてください。");
          const names = namesByElement(current.model);
          const report = upsertElements(current.model, body.elements);
          const version = await store.writeVersioned(name, current.model);
          const renamed = renamesSince(current.model, names);
          // 実際のデータの列名は、記録を残してから直す（直せなくても、保存したモデルは元に戻せるように）
          hist.push({ before: current.text, after: version, renamed, renamedScenarios: [] });
          if (hist.length > HISTORY_LIMIT) hist.shift();
          const data = await store.renameDataColumns(name, renamed);
          if (data.note) report.notes.push(data.note);
          const slides = await store.renameSlideNames(name, { elements: renamed });
          if (slides.note) report.notes.push(slides.note);
          const warning = [data.warning, slides.warning].filter(Boolean).join("\n");
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, { report, model, ...(warning ? { warning } : {}), ...(renamed.length ? { renamed } : {}) }];
        }
        if (action === "scenarios") {
          if (!Array.isArray(body.scenarios)) throw new HttpError(400, "scenarios がありません。");
          if (!body.scenarios.every((s) => s && typeof s === "object" && !Array.isArray(s) && typeof s.name === "string")) {
            throw new HttpError(400, "scenarios の中身は、name のある施策の変更（オブジェクト）にしてください。");
          }
          if (body.remove !== undefined && !(Array.isArray(body.remove) && body.remove.every((r) => typeof r === "string"))) {
            throw new HttpError(400, "remove は消す施策の名前の並びにしてください。");
          }
          if (body.scenarios.length === 0 && !body.remove?.length) throw new HttpError(400, "scenarios か remove を指定してください。");
          const names = namesByScenario(current.model);
          const report = setScenarios(current.model, body.scenarios, { remove: body.remove });
          const version = await store.writeVersioned(name, current.model);
          const renamedScenarios = scenarioRenamesSince(current.model, names);
          // 筋書きの中の名前は、記録を残してから直す（直せなくても、保存したモデルは元に戻せるように）
          hist.push({ before: current.text, after: version, renamed: [], renamedScenarios });
          if (hist.length > HISTORY_LIMIT) hist.shift();
          const slides = await store.renameSlideNames(name, { scenarios: renamedScenarios });
          if (slides.note) report.notes.push(slides.note);
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, slides.warning ? { report, model, warning: slides.warning } : { report, model }];
        }
        if (action === "remove") {
          const targets: RemoveTarget[] = body.elements;
          if (!Array.isArray(targets) || targets.length === 0) throw new HttpError(400, "elements がありません。");
          const named = (t: RemoveTarget) => typeof t.name === "string" || (typeof t.from === "string" && typeof t.to === "string");
          if (!targets.every((t) => t && typeof t === "object" && !Array.isArray(t) && named(t))) {
            throw new HttpError(400, "elements の中身は、消す要素の name（LINK なら from と to）にしてください。");
          }
          // つながるフローは残して端を雲にする（MCP の remove_elements の既定と同じ）。雲は消した要素のあった場所に置く
          const placeClouds = keepCloudsInPlace(current.model);
          const report = removeElements(current.model, targets);
          placeClouds();
          const version = await store.writeVersioned(name, current.model);
          // 実際のデータの列と筋書きはそのまま残す（合わなくなったところは「問題」に出る。元に戻せばまた合う）
          hist.push({ before: current.text, after: version, renamed: [], renamedScenarios: [] });
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
        const backScenarios = last.renamedScenarios.map(([from, to]): [string, string] => [to, from]);
        const data = await store.renameDataColumns(name, back);
        const slides = await store.renameSlideNames(name, { elements: back, scenarios: backScenarios });
        const warning = [data.warning, slides.warning].filter(Boolean).join("\n");
        const model = await loadModelResponse(store, name, hist.length);
        return [200, { model, ...(warning ? { warning } : {}), ...(back.length ? { renamed: back } : {}) }];
      });
      sendJSON(res, result[0], result[1]);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof StoreError ? 404 : e instanceof EditError ? 400 : 500;
      sendJSON(res, status, { error: (e as Error).message } satisfies EditErrorResponse);
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
      const body: ModelListResponse = { dir: store.dir, models: await store.list() };
      sendJSON(res, 200, body);
      return;
    }
    const write = p.match(/^\/api\/models\/([^/]+)\/(edit|scenarios|remove|undo)$/);
    if (write) {
      await handleWrite(req, res, write[1]!, write[2] as "edit" | "scenarios" | "remove" | "undo");
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
      watcher?.close();
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
