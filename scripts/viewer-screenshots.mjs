// ビューアの使い方（docs/VIEWER.md）に載せるスクリーンショットを撮り直す。
//
//   npm run build
//   npm run screenshots
//
// 見本のモデルを一時フォルダに作ってビューアを起動し、Edge か Chrome をヘッドレスで動かして撮る。
// 撮った画像は docs/images/viewer/ に上書きする。ブラウザの場所は環境変数 BROWSER_PATH でも指定できる。
// ブラウザは DevTools プロトコルで操作する（Node 22 以降の組み込みの WebSocket を使うので、追加の依存はない）。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "docs/images/viewer");
const samplesDir = path.join(root, "node_modules/simulation/src/api/import_export/ModelJSON/samples");

if (!existsSync(path.join(root, "dist/viewer/server.js")) || !existsSync(path.join(root, "dist/web/index.html"))) {
  console.error("先に npm run build を実行してください。");
  process.exit(1);
}
const core = await import(pathToImport("dist/core/index.js"));
const { startViewer } = await import(pathToImport("dist/viewer/server.js"));

function pathToImport(rel) {
  return new URL(`file:///${path.join(root, rel).replace(/\\/g, "/")}`).href;
}

// 画面の大きさ。画像は SCALE 倍の解像度になる
const W = 1280;
const H = 800;
const SCALE = 1.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
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
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    console.error("Edge か Chrome が見つかりません。環境変数 BROWSER_PATH にブラウザの場所を指定してください。");
    process.exit(1);
  }
  return found;
}

/** 見本のモデルを作る。一覧に並ぶ順と名前も、マニュアルの説明に合わせている */
function writeModels(dir) {
  const store = new core.ModelStore(dir);
  const population = core.emptyModel("人口モデル", { time_length: 50, time_units: "YEARS" });
  core.upsertElements(population, [
    { type: "STOCK", name: "Population", behavior: { initial_value: 1000 } },
    { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
    { type: "VARIABLE", name: "Death Rate", behavior: { value: 0.01 } },
    { type: "FLOW", name: "Births", from: null, to: "Population", behavior: { value: "[Population]*[Birth Rate]" } },
    { type: "FLOW", name: "Deaths", from: "Population", to: null, behavior: { value: "[Population]*[Death Rate]" } },
  ]);
  const broken = core.clone(population);
  broken.elements.find((e) => e.name === "Deaths").behavior.value = "[Population]*[Death Rat]";
  const disease = JSON.parse(readFileSync(path.join(samplesDir, "disease.json"), "utf8"));
  disease.name = "感染症モデル（SIR）";
  const predatorPrey = JSON.parse(readFileSync(path.join(samplesDir, "predator_prey.json"), "utf8"));
  return Promise.all([
    store.write("population", population),
    store.write("population_error", broken),
    store.write("disease", disease),
    store.write("predator_prey", predatorPrey),
  ]);
}

/** ヘッドレスのブラウザを DevTools プロトコルで操作する小さな道具 */
async function launchBrowser(profileDir) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(findBrowser(), [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-extensions",
    `--window-size=${W},${H}`,
    "about:blank",
  ]);
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === "page");
    } catch {
      // まだ起動していない
    }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error("ブラウザに接続できません。");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    const w = msg.id && waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
    else w.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expr, timeout = 10000) => {
    for (let t = 0; t < timeout; t += 100) {
      if (await evaluate(`!!(${expr})`)) return;
      await sleep(100);
    }
    throw new Error(`待ちきれませんでした: ${expr}`);
  };
  const rectOf = (selector) =>
    evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

  return {
    send,
    evaluate,
    waitFor,
    rectOf,
    async setColorScheme(scheme) {
      await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    },
    async open(url) {
      await send("Page.navigate", { url });
      await waitFor("document.querySelector('.react-flow__node')");
      await sleep(700); // 図を画面に合わせるアニメーションを待つ
    },
    click: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
    clickText: (selector, text) =>
      evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}).click()`),
    hover: (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
    async shot(name, clipSelector) {
      const params = { format: "png" };
      if (clipSelector) params.clip = { ...(await rectOf(clipSelector)), scale: 1 };
      const { data } = await send("Page.captureScreenshot", params);
      writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
      console.log(`  ${name}.png`);
    },
    close() {
      ws.close();
      proc.kill();
    },
  };
}

const work = mkdtempSync(path.join(tmpdir(), "im-viewer-shots-"));
const modelsDir = path.join(work, "models");
mkdirSync(modelsDir);
mkdirSync(outDir, { recursive: true });
await writeModels(modelsDir);
const viewer = await startViewer({ modelsDir, staticDir: path.join(root, "dist/web"), port: 0 });
const b = await launchBrowser(path.join(work, "browser-profile"));
const url = (hash) => `${viewer.url}?t=${Date.now()}#${hash}`;

try {
  console.log(`docs/images/viewer に撮っています（${viewer.url}）`);

  // 画面全体（座標のないモデルなので自動配置になる）
  await b.setColorScheme("light");
  await b.open(url("population"));
  await b.shot("overview");

  // 図（座標つきのモデル）
  await b.open(url("disease"));
  await b.shot("diagram", ".diagram");

  // 要素を選んだところ
  await b.click('.react-flow__node[data-id="el:β"]');
  await b.waitFor("document.querySelector('.details')");
  await b.shot("details");

  // 自動配置に切り替えたところ
  await b.clickText(".toggle", "自動配置");
  await sleep(800);
  await b.shot("auto-layout", ".diagram");

  // グラフとツールチップ
  await b.open(url("predator_prey"));
  const chart = await b.rectOf(".chart-area");
  await b.hover(chart.x + chart.width * 0.3, chart.y + chart.height * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await b.shot("chart", ".results");

  // 要素を 1 つ足して、表にしたところ
  await b.clickText(".series-chip", "Prey Births");
  await b.clickText(".segmented button", "表");
  await b.waitFor("document.querySelector('.table-area table')");
  await b.evaluate("document.activeElement?.blur()");
  await b.shot("table", ".results");

  // エラーのあるモデル
  await b.open(url("population_error"));
  await b.shot("errors");

  // AI の変更がその場で反映されるところ（MCP と同じ方法でファイルを書き換え、すぐ撮る）
  await b.open(url("population"));
  const store = new core.ModelStore(modelsDir);
  const m = await store.read("population");
  core.upsertElements(m, [
    { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.04 } },
    { type: "VARIABLE", name: "Immigrants", behavior: { value: 20 } },
    { type: "FLOW", name: "Immigration", from: null, to: "Population", behavior: { value: "[Immigrants]" } },
  ]);
  await store.write("population", m);
  await b.waitFor("document.querySelector('.is-changed')");
  await sleep(500);
  await b.shot("live-update");

  // 暗い配色
  await b.setColorScheme("dark");
  await b.open(url("disease"));
  await b.shot("dark");
} finally {
  b.close();
  await viewer.close();
  // ブラウザがファイルを離すまで少し待ってから消す
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    console.warn(`一時フォルダを消せませんでした: ${work}`);
  }
}
console.log("できました。");
process.exit(0);
