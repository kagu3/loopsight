// ヘッドレスの Edge か Chrome を DevTools プロトコルで操作する小さな道具。
// MCP の view_diagram（図を画像で返す）、view_slides と export_slides（発表モードを画像や PDF にする）と、マニュアルのスクリーンショットを撮るスクリプトで使う。
// Node 22 以降の組み込みの WebSocket を使うので、追加の依存はない。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export class BrowserNotFoundError extends Error {
  override name = "BrowserNotFoundError";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Edge か Chrome の場所。環境変数 BROWSER_PATH があればそれを使う */
export function findBrowser(): string {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new BrowserNotFoundError("Edge か Chrome が見つかりません。環境変数 BROWSER_PATH にブラウザの場所を指定してください。");
  return found;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Browser {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  evaluate<T = unknown>(expr: string): Promise<T>;
  waitFor(expr: string, timeout?: number): Promise<void>;
  rectOf(selector: string): Promise<Rect>;
  /** 画面の大きさと配色。scale は画像の解像度の倍率 */
  setViewport(width: number, height: number, options?: { scale?: number; colorScheme?: "light" | "dark" }): Promise<void>;
  /** 開いて、図が描かれるまで待つ */
  open(url: string, readyExpr?: string): Promise<void>;
  click(selector: string): Promise<void>;
  clickText(selector: string, text: string): Promise<void>;
  hover(x: number, y: number): Promise<void>;
  /** PNG を返す。selector を渡すとその要素の範囲だけ */
  screenshot(selector?: string): Promise<Buffer>;
  close(): Promise<void>;
}

/**
 * ヘッドレスのブラウザを起動する。使い終わったら close() する（ブラウザを終わらせ、一時的なプロフィールも消す）。
 * ポートはブラウザに選ばせ（--remote-debugging-port=0）、プロフィールの DevToolsActivePort から読む。
 * 決めたポートを使うと、前に残ったほかのブラウザにつながることがあるため
 */
export async function launchBrowser(): Promise<Browser> {
  const profile = mkdtempSync(path.join(tmpdir(), "im-browser-"));
  const proc: ChildProcess = spawn(
    findBrowser(),
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-extensions", "about:blank"],
    { stdio: "ignore" },
  );
  let port: string | undefined;
  /** ブラウザ全体を終わらせる。Edge は起動し直すことがあり、proc.kill() だけでは本体が残るので、先に Browser.close を送る */
  const closeBrowser = async () => {
    if (!port) return;
    try {
      const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve);
        ws.addEventListener("error", reject);
      });
      const closed = new Promise((resolve) => ws.addEventListener("close", resolve));
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await Promise.race([closed, sleep(3000)]);
    } catch {
      // もう終わっている
    }
  };
  const cleanup = async () => {
    await closeBrowser();
    proc.kill();
    // ブラウザがファイルを離すまで少し待ってから消す（離していなければ、間をおいて何度か試す）
    await sleep(300);
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // 消せなくても困らない（一時フォルダ）
    }
  };

  let page: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      port ??= readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim() || undefined;
      if (port) {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
        // 起動時に開いた about:blank を選ぶ（Edge はほかのページを開いていることがある）
        page = targets.find((t) => t.type === "page" && t.url === "about:blank");
      }
    } catch {
      // まだ起動していない
    }
    if (!page) await sleep(150);
  }
  if (!page) {
    await cleanup();
    throw new Error("ヘッドレスのブラウザに接続できません。");
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let seq = 0;
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(String(m.data)) as { id?: number; error?: unknown; result?: unknown };
    const w = msg.id ? waiting.get(msg.id) : undefined;
    if (!w) return;
    waiting.delete(msg.id!);
    if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
    else w.resolve(msg.result);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async <T>(expr: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  };
  const waitFor = async (expr: string, timeout = 10000) => {
    for (let t = 0; t < timeout; t += 100) {
      if (await evaluate<boolean>(`!!(${expr})`)) return;
      await sleep(100);
    }
    throw new Error(`待ちきれませんでした: ${expr}`);
  };
  const rectOf = (selector: string) =>
    evaluate<Rect>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );

  return {
    send,
    evaluate,
    waitFor,
    rectOf,
    async setViewport(width, height, options = {}) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: options.scale ?? 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: options.colorScheme ?? "light" }] });
    },
    async open(url, readyExpr = "document.querySelector('.react-flow__node')") {
      await send("Page.navigate", { url });
      await waitFor(readyExpr);
      await sleep(700); // 図を画面に合わせるアニメーションを待つ
    },
    async click(selector) {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async clickText(selector, text) {
      await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}).click()`);
    },
    async hover(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    },
    async screenshot(selector) {
      const params: Record<string, unknown> = { format: "png" };
      if (selector) params.clip = { ...(await rectOf(selector)), scale: 1 };
      const { data } = await send("Page.captureScreenshot", params);
      return Buffer.from(data as string, "base64");
    },
    async close() {
      ws.close();
      await cleanup();
    },
  };
}
