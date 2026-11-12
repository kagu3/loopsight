import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { EditError, ModelStore, StoreError, checkModelName, versionOf, type ModelJSON } from "../core/index.js";
import {
  VIEWER_HEADER,
  type ActualDataResult,
  type ChangeEvent,
  type DiagramExportRequest,
  type DiagramExportResponse,
  type EditErrorResponse,
  type EditResponse,
  type ModelListResponse,
  type ModelResponse,
  type UndoRequest,
} from "./api.js";
import { CONFLICT_MESSAGE, NOTHING_TO_UNDO, RequestError, UNDO_CONFLICT_MESSAGE, actualDataResult, applyWrite, buildModelResponse, pushHistory, type HistoryEntry, type WriteAction, type WriteBody } from "./shared.js";
import { DIAGRAM_FILE_BASE, exportFolderOf, writeDiagramImages } from "./diagram-export.js";
import { watchTree } from "./watch.js";

// ビューア（Web 画面）のサーバー。作業フォルダの ModelJSON を読んで返し、変更を Server-Sent Events で知らせる。
// 画面からの編集も受け付け、同じファイルに書き戻す（MCP の upsert_elements、remove_elements、set_scenarios、set_groups、set_loops、set_annotations、set_simulation と同じ処理を通す）。
// モデルを実行して返す形を作ることと、書き込みの確かめは shared.ts にまとめてあり、デモサイト（web/src/demo）と同じものを使う。
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

async function loadModelResponse(store: ModelStore, name: string, undoAvailable = 0): Promise<ModelResponse> {
  const { model, version } = await store.readVersioned(name);
  return modelResponse(store, name, model, version, undoAvailable);
}

async function modelResponse(store: ModelStore, name: string, model: ModelJSON, version: string, undoAvailable: number): Promise<ModelResponse> {
  const modified = (await stat(store.pathOf(name))).mtime.toISOString();
  const actual = await actualData(store, name, model);
  return buildModelResponse({ name, modified, version, undoAvailable, model, actual });
}

/** 実際のデータを読み、要素に合う列だけを要素名で返す。CSV がなければ undefined */
async function actualData(store: ModelStore, name: string, model: ModelJSON): Promise<ActualDataResult | undefined> {
  const text = await store.readData(name);
  if (text === undefined) return undefined;
  return actualDataResult(model, text, path.basename(store.dataPathOf(name)), versionOf(text));
}

const MAX_BODY = 1024 * 1024;
/** 図の画像（SVG と、base64 にした PNG）を受け取るときの上限 */
const MAX_IMAGE_BODY = 64 * 1024 * 1024;

/** 書き込みの要求が、このビューアの画面から来たものか確かめる */
function checkWriteRequest(req: IncomingMessage): void {
  if (req.method !== "POST") throw new RequestError(405, "POST で送ってください。");
  if (req.headers[VIEWER_HEADER.toLowerCase()] !== "1") throw new RequestError(403, "ビューアの画面からしか書き込めません。");
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new RequestError(415, "JSON で送ってください。");
  const origin = req.headers.origin;
  if (origin) {
    let host = "";
    try {
      host = new URL(origin).hostname;
    } catch {
      // 読めない Origin は断る
    }
    if (!ALLOWED_HOSTS.has(host) && host !== "::1") throw new RequestError(403, "ほかのサイトからは書き込めません。");
  }
}

async function readBody<T>(req: IncomingMessage, limit = MAX_BODY): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RequestError(413, "送る内容が大きすぎます。");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new RequestError(400, "JSON として読めません。");
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

  const handleWrite = async (req: IncomingMessage, res: ServerResponse, name: string, action: WriteAction) => {
    try {
      checkWriteRequest(req);
      const body = await readBody<WriteBody & UndoRequest>(req);
      if (typeof body?.version !== "string") throw new RequestError(400, "version がありません。");
      const result = await serial(name, async (): Promise<[number, EditResponse | EditErrorResponse]> => {
        const current = await store.readVersioned(name);
        const hist = historyOf(name);
        if (current.version !== body.version) {
          return [409, await conflict(name, CONFLICT_MESSAGE)];
        }
        if (action !== "undo") {
          const { report, renamed } = applyWrite(current.model, action, body);
          const version = await store.writeVersioned(name, current.model);
          // 実際のデータの列名は、記録を残してから直す（直せなくても、保存したモデルは元に戻せるように）。
          // 要素を消したときは、実際のデータの列はそのまま残す（合わなくなったところは「問題」に出る。元に戻せばまた合う）
          pushHistory(hist, { before: current.text, after: version, renamed });
          const data = await store.renameDataColumns(name, renamed);
          if (data.note && report && "notes" in report) report.notes.push(data.note);
          const model = await modelResponse(store, name, current.model, version, hist.length);
          return [200, { ...(report ? { report } : {}), model, ...(data.warning ? { warning: data.warning } : {}), ...(renamed.length ? { renamed } : {}) }];
        }
        const last = hist.at(-1);
        if (!last) throw new RequestError(400, NOTHING_TO_UNDO);
        if (last.after !== current.version) {
          hist.length = 0;
          return [409, await conflict(name, UNDO_CONFLICT_MESSAGE)];
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
      const status = e instanceof RequestError ? e.status : e instanceof StoreError ? 404 : e instanceof EditError ? 400 : 500;
      sendJSON(res, status, { error: (e as Error).message } satisfies EditErrorResponse);
    }
  };

  /** 画面の図を書き出した画像を、exports/<モデル名>/diagram.svg と diagram.png に書く */
  const handleExportDiagram = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    try {
      checkWriteRequest(req);
      const body = await readBody<DiagramExportRequest>(req, MAX_IMAGE_BODY);
      if (typeof body?.svg !== "string" || !body.svg.startsWith("<svg")) throw new RequestError(400, "svg がありません。");
      if (typeof body.png !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.png)) throw new RequestError(400, "png（base64）がありません。");
      const png = Buffer.from(body.png, "base64");
      if (png.subarray(1, 4).toString("latin1") !== "PNG") throw new RequestError(400, "png が PNG の画像ではありません。");
      try {
        await store.read(name);
      } catch (e) {
        throw e instanceof StoreError ? new RequestError(404, e.message) : e;
      }
      const written = await writeDiagramImages(store, exportFolderOf(name), DIAGRAM_FILE_BASE, { svg: body.svg, png });
      sendJSON(res, 200, written satisfies DiagramExportResponse);
    } catch (e) {
      sendJSON(res, e instanceof RequestError ? e.status : 500, { error: (e as Error).message } satisfies EditErrorResponse);
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
    const write = url.pathname.match(/^\/api\/models\/(.+)\/(edit|scenarios|groups|loops|simulation|remove|undo)$/);
    if (write) {
      await handleWrite(req, res, decodeURIComponent(write[1]!), write[2] as WriteAction);
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
