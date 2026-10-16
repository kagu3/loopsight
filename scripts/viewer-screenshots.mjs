// ビューアの使い方（docs/VIEWER.md）に載せるスクリーンショットを撮り直す。
//
//   npm run build
//   npm run screenshots
//
// 見本のモデルを一時フォルダに作ってビューアを起動し、Edge か Chrome をヘッドレスで動かして撮る。
// 撮った画像は docs/images/viewer/ に上書きする（見本のモデルは一時フォルダにあるので、編集の場面を撮っても作業フォルダは変わらない）。ブラウザの場所は環境変数 BROWSER_PATH でも指定できる。
// ブラウザの操作は dist/viewer/browser.js（MCP の view_diagram と同じ道具）を使う。
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
const { launchBrowser, BrowserNotFoundError } = await import(pathToImport("dist/viewer/browser.js"));

function pathToImport(rel) {
  return new URL(`file:///${path.join(root, rel).replace(/\\/g, "/")}`).href;
}

// 画面の大きさ。画像は SCALE 倍の解像度になる
const W = 1280;
const H = 800;
const SCALE = 1.5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const work = mkdtempSync(path.join(tmpdir(), "im-viewer-shots-"));
const modelsDir = path.join(work, "models");
mkdirSync(modelsDir);
mkdirSync(outDir, { recursive: true });
await writeModels(modelsDir);
const viewer = await startViewer({ modelsDir, staticDir: path.join(root, "dist/web"), port: 0 });
let b;
try {
  b = await launchBrowser();
} catch (e) {
  console.error(e instanceof BrowserNotFoundError ? e.message : e);
  await viewer.close();
  process.exit(1);
}
const shot = async (name, clipSelector) => {
  writeFileSync(path.join(outDir, `${name}.png`), await b.screenshot(clipSelector));
  console.log(`  ${name}.png`);
};
const setColorScheme = (scheme) => b.setViewport(W, H, { scale: SCALE, colorScheme: scheme });
const url = (hash) => `${viewer.url}?t=${Date.now()}#${hash}`;

try {
  console.log(`docs/images/viewer に撮っています（${viewer.url}）`);

  // 画面全体（座標のないモデルなので、仮に並べて描く）
  await setColorScheme("light");
  await b.open(url("population"));
  await shot("overview");

  // 図（座標つきのモデル）
  await b.open(url("disease"));
  await shot("diagram", ".diagram");

  // 要素を選んだところ
  await b.click('.react-flow__node[data-id="el:β"]');
  await b.waitFor("document.querySelector('.details')");
  await shot("details");

  // 要素を編集しているところ
  await b.clickText(".details .small-button", "編集");
  await b.waitFor("document.querySelector('.form textarea')");
  await b.evaluate("(() => { const t = document.querySelector('.form textarea'); t.focus(); t.select(); })()");
  await b.send("Input.insertText", { text: "0.02" });
  await sleep(200);
  await shot("edit");
  await b.clickText(".form-buttons button", "やめる");

  // グラフとツールチップ
  await b.open(url("predator_prey"));
  const chart = await b.rectOf(".chart-area");
  await b.hover(chart.x + chart.width * 0.3, chart.y + chart.height * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await shot("chart", ".results");

  // 要素を選ぶ一覧を開いて、要素を 1 つ足したところ
  await b.click(".picker-button");
  await b.waitFor("document.querySelector('.series-popover')");
  await b.clickText(".series-option", "Prey Births");
  await shot("picker", ".results");

  // 一覧を閉じて、表にしたところ
  await b.click(".picker-button");
  await b.clickText(".segmented button", "表");
  await b.waitFor("document.querySelector('.table-area table')");
  await b.evaluate("document.activeElement?.blur()");
  await shot("table", ".results");

  // 大きさの違う要素を正規化して並べたところ（あとの場面のために、実際の値に戻しておく）
  await b.clickText(".segmented button", "グラフ");
  await b.clickText(".segmented button", "正規化");
  const normalized = await b.rectOf(".chart-area");
  await b.hover(normalized.x + normalized.width * 0.3, normalized.y + normalized.height * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await shot("normalized", ".results");
  await b.clickText(".segmented button", "実際の値");

  // エラーのあるモデル
  await b.open(url("population_error"));
  await shot("errors");

  // 実際のデータを点で重ねたところ（見本の CSV を MCP の import_data と同じ場所に置く。あとの場面に出ないよう、撮ったら消す）
  // ここでページを開き直すと、あとの「その場で反映」の場面で変更の知らせの接続が開かなくなる（同じサーバーへの接続が足りなくなるらしい）。# だけ変えてモデルを切り替える
  const dataFile = new core.ModelStore(modelsDir).dataPathOf("population");
  writeFileSync(dataFile, readFileSync(path.join(root, "examples/population.data.csv")));
  await b.evaluate("location.hash = 'population'");
  await b.waitFor("document.querySelector('.legend-actual')");
  await sleep(700);
  const actual = await b.rectOf(".chart-area");
  // 20 年（データのある時刻）のあたり
  await b.hover(actual.x + actual.width * 0.44, actual.y + actual.height * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await shot("actual-data", ".results");
  rmSync(dataFile);

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
  await shot("live-update");

  // AI が施策を保存して、「何もしない場合」と重ねたところ（MCP の set_scenarios と同じ処理でファイルを書き換える）。
  // 開いている画面のまま撮る（ページを開き直すたびにビューアへのつながりが残り、ブラウザの同時接続の上限に近づくため）
  core.setScenarios(m, [
    { name: "移民を増やす", description: "受け入れを毎年 50 人にする", values: { Immigrants: 50 } },
    { name: "死亡率を下げる", description: "医療を充実させて死亡率を 0.5% にする", values: { "Death Rate": 0.005 } },
    { name: "組み合わせる", description: "受け入れを少し増やし、出生率を少し上げ、死亡率を少し下げる", values: { Immigrants: 30, "Birth Rate": 0.045, "Death Rate": 0.008 } },
  ]);
  await store.write("population", m);
  await b.waitFor("document.querySelector('.compare-grid .recharts-line')");
  await sleep(300);
  const cell = await b.rectOf(".compare-chart");
  await b.hover(cell.x + cell.width * 0.7, cell.y + cell.height * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await shot("scenarios", ".results");

  // 施策の凡例にカーソルを乗せて、図の変えた要素に札が付いたところ（4 つ目の「組み合わせる」）。
  // 前の場面で変わった要素の枠が消えてから撮る（札の枠と紛らわしくないように）
  await b.waitFor("!document.querySelector('.is-changed')");
  await sleep(300);
  const combined = await b.rectOf(".scenario-legend .scenario-chip:nth-child(4) .scenario-chip-button");
  await b.hover(combined.x + combined.width / 2, combined.y + combined.height / 2);
  await b.waitFor("document.querySelector('.scenario-badge')");
  await sleep(200);
  await shot("scenario-badges");

  // 施策の凡例を押して、左の欄で施策を直しているところ（保存せずに閉じる）
  await b.hover(W - 4, H - 4);
  // 施策名の横に変えた値の数も出るので、名前の部分で探す
  await b.evaluate("[...document.querySelectorAll('.scenario-chip-button')].find((e) => e.querySelector('.legend-name')?.textContent === '移民を増やす').click()");
  await b.waitFor("document.querySelector('.scenario-table input')");
  await b.evaluate("(() => { const t = document.querySelector('.scenario-table input'); t.focus(); t.select(); })()");
  await b.send("Input.insertText", { text: "80" });
  await sleep(200);
  await shot("scenario-edit");
  await b.clickText(".form-buttons button", "やめる");

  // 施策の凡例を開いて、施策の中身（変えた値と結果）の表にしたところ。グラフにカーソルを乗せ、その時点の結果を出す（撮ったら閉じておく）
  await b.clickText(".scenario-toggle", "▸ 中身を見る");
  await b.waitFor("document.querySelector('.scenario-matrix')");
  await sleep(300);
  const matrixCell = await b.rectOf(".compare-chart");
  await b.hover(matrixCell.x + matrixCell.width * 0.7, matrixCell.y + matrixCell.height * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await shot("scenario-matrix", ".results");
  await b.hover(W - 4, H - 4);
  await b.clickText(".scenario-toggle", "▾ 中身を閉じる");

  // 発表モード（MCP の set_slides で保存した筋書きを ?view=present で見せる）。比較のスライドを 16:9 で撮る
  await store.writeSlides(
    "population",
    core.toSlideDeck({
      title: "人口の見通し",
      slides: [
        {
          kind: "compare",
          title: "50 年後の人口を比べる",
          message: "どちらの施策でも人口は増えます。移民を増やすほうが、50 年後の人口は多くなります。",
          scenarios: ["移民を増やす", "死亡率を下げる"],
          elements: ["Population"],
          at: 50,
        },
      ],
    }),
  );
  await b.setViewport(W, (W * 9) / 16, { scale: SCALE, colorScheme: "light" });
  await b.open(`${viewer.url}?view=present&slide=1&t=${Date.now()}#population`, "document.querySelector('.slide[data-ready=\"1\"]')");
  await shot("present");

  // 暗い配色
  await setColorScheme("dark");
  await b.open(url("disease"));
  await shot("dark");
} finally {
  await b.close();
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
