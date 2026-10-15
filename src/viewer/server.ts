import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { ModelError, ModelStore, StoreError, runModel, validateModel } from "../core/index.js";
import type { ChangeEvent, ModelListResponse, ModelResponse, RunResult } from "./api.js";

// 見るための Web 画面のサーバー。作業フォルダの ModelJSON を読んで返し、変更を Server-Sent Events で知らせる。
// 127.0.0.1 だけで待ち受け、Host ヘッダーも確かめる（DNS リバインディングで別のサイトから読まれないように）。

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

export async function loadModelResponse(store: ModelStore, name: string): Promise<ModelResponse> {
  const model = await store.read(name);
  const modified = (await stat(store.pathOf(name))).mtime.toISOString();
  const validation = validateModel(model, { trialRun: false });
  const res: ModelResponse = { name, modified, model, validation };
  if (validation.ok) {
    try {
      const data = runModel(model);
      const series: RunResult["series"] = {};
      for (const [k, values] of data.columns) series[k] = values.map(toNumber);
      res.run = { time_units: data.timeUnits, times: data.times, series };
    } catch (e) {
      const err = e instanceof ModelError ? e : new ModelError((e as Error).message, []);
      res.run_error = { message: err.message, issues: err.issues };
    }
  }
  return res;
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function startViewer(options: ViewerOptions): Promise<Viewer> {
  const store = new ModelStore(options.modelsDir);
  const clients = new Set<ServerResponse>();

  // 作業フォルダの監視。同じファイルの変更が続けて届くので、少し待ってからまとめて送る
  const pending = new Map<string, NodeJS.Timeout>();
  let watcher: FSWatcher | undefined;
  const notify = (file: string) => {
    if (!file.toLowerCase().endsWith(".json")) return;
    const name = file.replace(/\.json$/i, "");
    clearTimeout(pending.get(name));
    pending.set(
      name,
      setTimeout(async () => {
        pending.delete(name);
        const exists = await stat(path.join(store.dir, file)).then(
          () => true,
          () => false,
        );
        const event: ChangeEvent = { type: exists ? "changed" : "removed", name };
        for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
      }, 150),
    );
  };
  try {
    watcher = watch(store.dir, (_event, file) => file && notify(file.toString()));
  } catch {
    // 作業フォルダがまだないときは監視しない（一覧は空になる）
  }

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
    if (p.startsWith("/api/models/")) {
      try {
        sendJSON(res, 200, await loadModelResponse(store, p.slice("/api/models/".length)));
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
