// ビューアの使い方（docs/viewer.md）に載せるスクリーンショットを撮り直す。
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
  // 上の帯の 2 行目には、説明の最初の段落だけが出る
  population.description = "生まれる人が死ぬ人より多いので、人口は増え続ける。\n\nBirth Rate と Death Rate は 1 年あたりの割合。";
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

  // 編集モードをオンにしたところ（あとの場面に出ないよう、撮ったらオフに戻す）
  await b.clickText(".edit-toggle", "✎ 図を編集");
  await b.waitFor("document.querySelector('.edit-tools.on')");
  await shot("edit-mode");
  await b.clickText(".edit-toggle", "✎ 図を編集");

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

  // エラーのあるモデル
  await b.open(url("population_error"));
  await shot("errors");

  // 実際のデータを点で重ねたところ（見本の CSV を MCP の import_data と同じ場所に置く。あとの場面に出ないよう、撮ったら消す）
  // ここでページを開き直すと、あとの「その場で反映」の場面で変更の知らせの接続が開かなくなる（同じサーバーへの接続が足りなくなるらしい）。# だけ変えてモデルを切り替える
  const dataFile = new core.ModelStore(modelsDir).dataPathOf("population");
  writeFileSync(dataFile, readFileSync(path.join(root, "tests/fixtures/population.data.csv")));
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

  // AI がシナリオを保存して、何も変えない実行と重ねたところ（MCP の set_scenarios と同じ処理でファイルを書き換える）。
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

  // シナリオの凡例にカーソルを乗せて、図の変えた要素に札が付いたところ（4 つ目の「組み合わせる」）。
  // 前の場面で変わった要素の枠が消えてから撮る（札の枠と紛らわしくないように）
  await b.waitFor("!document.querySelector('.is-changed')");
  await sleep(300);
  const combined = await b.rectOf(".scenario-legend .scenario-chip:nth-child(4) .scenario-chip-button");
  await b.hover(combined.x + combined.width / 2, combined.y + combined.height / 2);
  await b.waitFor("document.querySelector('.scenario-badge')");
  await sleep(200);
  await shot("scenario-badges");

  await b.hover(W - 4, H - 4);

  // シナリオの凡例を開いて、シナリオの中身（変えた値と結果）の表にしたところ。グラフにカーソルを乗せ、その時点の結果を出す（撮ったら閉じておく）
  await b.clickText(".scenario-toggle", "▸ 中身を見る");
  await b.waitFor("document.querySelector('.scenario-matrix')");
  // 表のぶんグラフが下に押し出されるので、境界線を上にドラッグして下の欄を高くし、ツールチップが全部見えるようにする
  // （100px は今の表の行の数に合わせたもの。表の行が増えたら見直す）
  const splitter = await b.rectOf(".splitter");
  const sy = splitter.y + splitter.height / 2;
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: splitter.x + 40, y: sy, button: "left", clickCount: 1 });
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: splitter.x + 40, y: sy - 100, button: "left" });
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: splitter.x + 40, y: sy - 100, button: "left", clickCount: 1 });
  await sleep(300);
  const matrixCell = await b.rectOf(".compare-chart");
  // それでもグラフの下半分は画面の外に出るので、画面に見えている部分の真ん中に乗せる
  await b.hover(matrixCell.x + matrixCell.width * 0.7, matrixCell.y + Math.min(matrixCell.height, H - matrixCell.y) * 0.5);
  await b.waitFor("document.querySelector('.tooltip')");
  await shot("scenario-matrix", ".results");
  await b.hover(W - 4, H - 4);

  // 表の見出しのシナリオの名前を押して、吹き出しで名前を変えているところ（保存せずに閉じる）。
  // シナリオ名の横に変えた値の数も出るので、名前の部分で探す
  const pressScenario = (name) =>
    b.evaluate(`[...document.querySelectorAll('.scenario-matrix .scenario-chip-button')].find((e) => e.querySelector('.legend-name')?.textContent === ${JSON.stringify(name)}).click()`);
  await pressScenario("移民を増やす");
  await b.waitFor("document.activeElement?.closest('.scenario-menu')");
  await b.send("Input.insertText", { text: "移民を大きく増やす" });
  await sleep(200);
  await shot("scenario-edit", ".results");

  // 吹き出しの「説明を直す」で、左の欄でシナリオの説明を直しているところ（保存せずに閉じる）
  await b.clickText(".scenario-menu button", "説明を直す");
  await b.waitFor("document.querySelector('.sidebar textarea')");
  await b.evaluate("(() => { const t = document.querySelector('.sidebar textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()");
  await b.send("Input.insertText", { text: "。毎年の受け入れを 2.5 倍にする" });
  // 表のマスにカーソルが乗ったままにならないよう、左の欄の空いているところに移す
  await b.hover(150, 400);
  await sleep(200);
  await shot("scenario-description");
  await b.clickText(".form-buttons button", "やめる");
  await b.clickText(".scenario-toggle", "▾ 中身を閉じる");
  // 変えた高さは覚えられるので、あとの場面のために消しておく
  await b.evaluate("localStorage.removeItem('viewer.resultsRatio')");

  // 暗い配色
  await setColorScheme("dark");
  await b.open(url("disease"));
  await shot("dark");

  // 図の「値を表示」：ブルウィップ効果のモデルで、要素ごとの最大の振れを出したところ。
  // 一覧の場面に出ないよう、モデルはここで足す（ページは開き直さず、# だけ変える）。図を広く見せるため、左の欄をたたむ
  await setColorScheme("light");
  const bullwhip = JSON.parse(readFileSync(path.join(root, "tests/fixtures/bullwhip.json"), "utf8"));
  await store.write("bullwhip", bullwhip);
  await b.evaluate("location.hash = 'bullwhip'");
  await b.waitFor("document.querySelector('.react-flow__node[data-id=\"el:工場の生産指示\"]')");
  await b.click(".sidebar-collapse");
  await sleep(500);
  await b.clickText(".value-tools .edit-toggle", "値を表示");
  await b.waitFor("document.querySelector('.live-value')");
  await sleep(300);
  await shot("diagram-values");

  // 「値を表示」で要素を選んで、式にその時点の値を入れたものを出したところ（変数・ストック・時間をまたぐ関数を含むフロー）
  await b.click('.react-flow__node[data-id="el:小売の発注"]');
  await b.waitFor("document.querySelector('.formula-card')?.style.visibility === ''");
  await sleep(200);
  await shot("formula-values", ".diagram");
  // ストックは、グラフにカーソルを乗せた時刻（在庫が減っていくところ）の、入る量と出る量
  await b.click('.react-flow__node[data-id="el:小売の在庫"]');
  const formulaChart = await b.rectOf(".chart-area");
  await b.hover(formulaChart.x + formulaChart.width * 0.4, formulaChart.y + formulaChart.height * 0.5);
  await b.waitFor("document.querySelector('.formula-caption')?.textContent.endsWith('週の値')");
  await sleep(200);
  await shot("formula-stock", ".diagram");
  await b.hover(W - 4, 60);
  // カーソルを外すと最大の振れの時点に戻り、ストックには、カーソルを乗せる案内を添える
  await b.waitFor("document.querySelector('.formula-caption')?.textContent.endsWith('（最大の振れ）') && document.querySelector('.formula-card').textContent.includes('グラフにカーソルを乗せると')");
  await b.click('.react-flow__node[data-id="valve:卸から小売への出荷"]');
  await b.waitFor("document.querySelector('.formula-card')?.textContent.includes('Delay')");
  await sleep(200);
  await shot("formula-function", ".diagram");
  // 選ぶのをやめると消える（次の場面に出さない）
  await b.click(".react-flow__pane");
  await b.waitFor("!document.querySelector('.formula-card')");

  // グラフにカーソルを乗せて、その時刻（9 週あたり）の値を出したところ
  const bwChart = await b.rectOf(".chart-area");
  await b.hover(bwChart.x + bwChart.width * 0.2, bwChart.y + bwChart.height * 0.5);
  await b.waitFor("document.querySelector('.value-caption')?.textContent.endsWith('週の値')");
  await sleep(200);
  // 範囲を決めずに撮ると、カーソルがグラフから外れたことになるので、右側（図とグラフ）の範囲で撮る
  await shot("diagram-values-hover", ".main");
  await b.hover(W - 4, 60);

  // シナリオを保存して、そのシナリオの値を出したところ（図の欄だけを撮る）
  core.setScenarios(bullwhip, [{ name: "在庫をゆっくり直す", description: "在庫の不足を 8 週かけて埋める", values: { 在庫の調整時間: 8 } }]);
  await store.write("bullwhip", bullwhip);
  await b.waitFor("document.querySelector('.value-scenario')");
  await b.evaluate(`(() => {
    const s = document.querySelector('.value-scenario');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '在庫をゆっくり直す');
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(300);
  await shot("diagram-values-scenario", ".diagram");

  // 名前の長い参照が多く、下の行をそろえると箱に収まらない式は、参照ごとの値の一覧で出す
  const inputs = { 来店客数: 100, 購入する人の割合: 0.3, 一人あたりの購入点数: 2.5, 季節による売れ行きの変化: 1.1, 値引きによる売れ行きの上乗せ: 1.05, 在庫切れで売れなかった分: 12, 返品された分: 3 };
  const names = Object.keys(inputs);
  await store.write("sales", {
    name: "販売の見込み",
    simulation: { time_start: 0, time_length: 10, time_step: 1, time_units: "WEEKS" },
    elements: [
      ...names.map((n, i) => ({ type: "VARIABLE", name: n, behavior: { value: inputs[n] }, display: { coordinates: [40 + (i % 4) * 230, i < 4 ? 40 : 320] } })),
      {
        type: "VARIABLE",
        name: "販売の見込み",
        behavior: { value: names.slice(0, 5).map((n) => `[${n}]`).join(" * ") + " - [在庫切れで売れなかった分] - [返品された分]" },
        display: { coordinates: [380, 180] },
      },
      ...names.map((n) => ({ type: "LINK", from: n, to: "販売の見込み" })),
    ],
  });
  await b.evaluate("location.hash = 'sales'");
  await b.waitFor("document.querySelector('.react-flow__node[data-id=\"el:販売の見込み\"]')");
  await sleep(700);
  await b.click('.react-flow__node[data-id="el:販売の見込み"]');
  await b.waitFor("document.querySelector('.formula-card.is-list')?.style.visibility === ''");
  await sleep(200);
  await shot("formula-list", ".diagram");
  // 覚えた「値を表示」は、次に撮るときのために消しておく
  await b.evaluate("localStorage.removeItem('viewer.diagramValues')");

  // フォルダごとに出したモデルの一覧（フォルダの中のモデルを開いて、ほかのフォルダも 1 つ開く）
  await setColorScheme("light");
  const population = await store.read("population");
  // 前の場面で足したモデルは消して、一覧が画面に収まるようにする
  for (const name of ["bullwhip", "sales", "population_error"]) await store.removeModel(name);
  await store.write("ブルックスの法則/brooks_law", { ...population, name: "ブルックスの法則" });
  await store.write("ブルックスの法則/brooks_law_detailed", { ...population, name: "ブルックスの法則（詳しい版）" });
  await store.write("事例/在庫/bullwhip", { ...population, name: "ブルウィップ効果" });
  await store.write("事例/在庫/bullwhip_対策", { ...population, name: "ブルウィップ効果の対策" });
  await store.createFolder("新しいモデル置き場");
  // 書き出したファイルのフォルダは一覧に出ない
  mkdirSync(path.join(modelsDir, "exports", "population"), { recursive: true });
  writeFileSync(path.join(modelsDir, "exports", "population", "diagram.png"), "");
  await b.evaluate("localStorage.removeItem('viewer.openFolders')");
  // 「値を表示」の場面でたたんだ左の欄は、ブラウザが覚えている。開いた状態に戻してから開く
  await b.evaluate("localStorage.removeItem('viewer.sidebarOpen')");
  await b.open(url(`${encodeURIComponent("ブルックスの法則")}/brooks_law`));
  await b.waitFor("document.querySelector('.folder-toggle')");
  await b.clickText(".folder-name", "事例");
  await b.clickText(".folder-name", "在庫");
  await sleep(300);
  await shot("model-folders", ".models-panel");
  await b.evaluate("localStorage.removeItem('viewer.openFolders')");
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
