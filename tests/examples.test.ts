// examples/ の sample（システム思考を学ぶ教材）が、sample の決まり（examples/README.md）を守っているかを確かめる。
// sample が 0 個でも、examples/ がなくても通る
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkDiagram,
  emptyModel,
  findLoops,
  layoutModel,
  runScenarios,
  setScenarios,
  toModelError,
  upsertElements,
  validateModel,
  type ModelJSON,
} from "../src/core/index.js";

const EXAMPLES_DIR = path.resolve("examples");

/** examples/ の下の ModelJSON（*.json。拡張子の大文字と小文字は区別しない）の、examples/ からの相対パス（/ 区切り）。.data.csv などは含めない */
function exampleFiles(dir = EXAMPLES_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return exampleFiles(full);
    return e.name.toLowerCase().endsWith(".json") ? [path.relative(EXAMPLES_DIR, full).split(path.sep).join("/")] : [];
  });
}

/** 置き方の決まり（examples/<番号>_<名前>/<英数字>.json）に反していれば、その理由を返す */
function placementProblems(file: string): string[] {
  const parts = file.split("/");
  if (parts.length !== 2) return [`examples/<番号>_<名前>/<英数字>.json の形に置く（いまは examples/${file}）`];
  const [folder, name] = parts as [string, string];
  const problems: string[] = [];
  if (!/^\d+_\S+$/.test(folder)) problems.push(`フォルダの名前を <番号>_<名前> にする（いまは ${folder}）`);
  if (!/^[A-Za-z0-9_-]+\.json$/i.test(name)) problems.push(`モデルのファイル名は英数字と _ - にする（いまは ${name}）`);
  return problems;
}

/** モデルが sample の決まりに反しているところ（決まりごとに 1 行）。守っていれば空 */
function sampleProblems(model: ModelJSON): string[] {
  const problems: string[] = [];

  const v = validateModel(model, { trialRun: true });
  for (const i of v.errors) problems.push(`検証のエラー：${i.element ? `${i.element}：` : ""}${i.message}`);
  for (const i of v.warnings) problems.push(`検証の警告：${i.element ? `${i.element}：` : ""}${i.message}`);

  if (!model.description?.trim()) problems.push("モデルの説明（description）がない");

  for (const el of model.elements) {
    if (el.type !== "LINK") continue;
    const p = el.behavior?.polarity;
    if (p !== "POSITIVE" && p !== "NEGATIVE") problems.push(`リンク ${el.from} → ${el.to} に極性（behavior.polarity）がない`);
  }
  for (const loop of findLoops(model).loops) {
    if (loop.kind === "unknown") problems.push(`R か B か決まっていないループがある：${loop.elements.join(" → ")}`);
  }

  const scenarios = model.scenarios ?? [];
  if (!scenarios.length) problems.push("シナリオがない（てこのシナリオを 1 つ以上入れる）");
  // 検証でエラーがあれば元のモデルは動かないので、シナリオの実行は確かめない
  if (scenarios.length && !v.errors.length) {
    try {
      for (const run of runScenarios(model).scenarios) {
        if (run.error) problems.push(`シナリオ「${run.name}」が実行できない：${run.error.message}`);
      }
    } catch (e) {
      problems.push(`元のモデルが実行できない：${toModelError(e).message}`);
    }
  }

  const d = checkDiagram(model);
  if (d.missing_coordinates) problems.push("図の座標のない要素がある（layout_model などで座標を付ける）");
  for (const o of d.overlaps) problems.push(`図の重なり：${o}`);
  for (const l of d.lines_through_elements) problems.push(`線が要素の上を通る：${l}`);

  return problems;
}

/** 決まりを守った小さなモデル（コーヒーが冷める）。単体のテストで、ここから 1 つずつ壊す */
function goodModel(): ModelJSON {
  const m = emptyModel("coffee", { time_length: 60, time_units: "MINUTES" });
  m.description = "テスト用。コーヒーの温度が室温に近づく。";
  upsertElements(m, [
    { type: "STOCK", name: "コーヒーの温度", behavior: { initial_value: 90 } },
    { type: "VARIABLE", name: "室温", behavior: { value: 20 } },
    { type: "FLOW", name: "冷める", from: "コーヒーの温度", to: null, behavior: { value: "([コーヒーの温度] - [室温]) * 0.1" } },
  ]);
  upsertElements(m, [
    { type: "LINK", from: "コーヒーの温度", to: "冷める", behavior: { polarity: "POSITIVE" } },
    { type: "LINK", from: "室温", to: "冷める", behavior: { polarity: "NEGATIVE" } },
  ]);
  setScenarios(m, [{ name: "寒い部屋", values: { 室温: 5 } }]);
  layoutModel(m);
  return m;
}

const linkOf = (m: ModelJSON, from: string, to: string) => m.elements.find((e) => e.type === "LINK" && e.from === from && e.to === to)!;

describe("examples/ の sample", () => {
  const files = exampleFiles();

  test.each(files.length ? files : ["（sample なし）"])("%s が sample の決まりを守っている", (file) => {
    if (!files.length) return; // sample が 0 個でも通る
    const problems = placementProblems(file);
    let model: ModelJSON | undefined;
    try {
      model = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, file), "utf8")) as ModelJSON;
    } catch (e) {
      problems.push(`ModelJSON として読めない：${(e as Error).message}`);
    }
    if (model) problems.push(...sampleProblems(model));
    expect(problems, `examples/${file} が sample の決まり（examples/README.md）に反しています:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("sample の決まりの判定", () => {
  test("決まりを守ったモデルには何も言わない", () => {
    expect(sampleProblems(goodModel())).toEqual([]);
  });

  test("置き方：examples/<番号>_<名前>/<英数字>.json", () => {
    expect(placementProblems("0_コーヒーが冷める/coffee.json")).toEqual([]);
    expect(placementProblems("coffee.json")).toHaveLength(1);
    expect(placementProblems("0_コーヒー/sub/coffee.json")).toHaveLength(1);
    expect(placementProblems("コーヒー/coffee.json")).toEqual([expect.stringContaining("<番号>_<名前>")]);
    expect(placementProblems("0_コーヒー/コーヒー.json")).toEqual([expect.stringContaining("英数字")]);
    expect(placementProblems("0_コーヒー/coffee-cooling_2.JSON")).toEqual([]);
  });

  test("検証のエラーと警告", () => {
    const broken = goodModel();
    broken.elements.find((e) => e.name === "室温")!.behavior!.value = "[ない要素] + 1";
    expect(sampleProblems(broken)).toEqual(expect.arrayContaining([expect.stringMatching(/^検証のエラー/)]));
  });

  test("説明がない", () => {
    const m = goodModel();
    delete m.description;
    expect(sampleProblems(m)).toEqual(["モデルの説明（description）がない"]);
  });

  test("極性のないリンクと、R か B か決まっていないループ", () => {
    const m = goodModel();
    linkOf(m, "コーヒーの温度", "冷める").behavior!.polarity = "NEUTRAL";
    expect(sampleProblems(m)).toEqual([
      "リンク コーヒーの温度 → 冷める に極性（behavior.polarity）がない",
      expect.stringMatching(/^R か B か決まっていないループがある/),
    ]);
  });

  test("シナリオがない、実行できないシナリオがある", () => {
    const none = goodModel();
    none.scenarios = [];
    expect(sampleProblems(none)).toEqual(["シナリオがない（てこのシナリオを 1 つ以上入れる）"]);
    const bad = goodModel();
    bad.scenarios = [{ name: "壊れた", values: { 室温: "[ない要素]" } }];
    expect(sampleProblems(bad)).toEqual([expect.stringMatching(/^シナリオ「壊れた」が実行できない/)]);
  });

  test("図の重なり、線が要素の上を通るところ、座標のない要素", () => {
    const overlap = goodModel();
    const stock = overlap.elements.find((e) => e.name === "コーヒーの温度")!;
    overlap.elements.find((e) => e.name === "室温")!.display!.coordinates = [...stock.display!.coordinates!];
    expect(sampleProblems(overlap)).toEqual(expect.arrayContaining([expect.stringMatching(/^図の重なり/)]));

    // フロー「冷める」の線（ストックの中心から行き先の雲まで）の上に、室温（120×50）を置く
    const through = goodModel();
    const pos = checkDiagram(through).positions;
    const box = pos.find((p) => p.name === "コーヒーの温度")!;
    const cloud = pos.find((p) => p.type === "CLOUD")!;
    const from = [box.coordinates[0] + box.size![0] / 2, box.coordinates[1] + box.size![1] / 2];
    const mid = [(from[0]! + cloud.coordinates[0]) / 2, (from[1]! + cloud.coordinates[1]) / 2];
    through.elements.find((e) => e.name === "室温")!.display!.coordinates = [mid[0]! - 60, mid[1]! - 25];
    expect(sampleProblems(through)).toEqual(expect.arrayContaining([expect.stringMatching(/^線が要素の上を通る/)]));

    const missing = goodModel();
    delete missing.elements.find((e) => e.name === "室温")!.display!.coordinates;
    expect(sampleProblems(missing)).toContain("図の座標のない要素がある（layout_model などで座標を付ける）");
  });
});
