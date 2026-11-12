// examples/ の sample（システム思考を学ぶ教材）が、sample の決まり（examples/README.md）を守っているかを確かめる。
// sample が 0 個でも、examples/ がなくても通る
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  annotationsOf,
  checkActualData,
  DEFAULT_BASELINE_NAME,
  checkDiagram,
  emptyModel,
  findLoops,
  layoutModel,
  parseDataCSV,
  runScenarios,
  setLoops,
  setScenarios,
  toModelError,
  upsertElements,
  validateModel,
  wellFormedLoops,
  type ModelJSON,
} from "../src/core/index.js";
import { firstParagraph } from "../web/src/description.js";

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

/** 説明の見出しの並び（examples/README.md の「中身の決まり」）。見出しは行の頭に置く。最初の段落（概要）には見出しを付けない */
const DESCRIPTION_HEADINGS = [
  "どんな問題か",
  "どんな構造か",
  "どんな動きになるか",
  "てこはどこか",
  "数字と単純化について",
  "もっと詳しく",
];

/** 概要（説明の最初の段落）の長さの上限。空白も 1 文字に数える。ビューアの上の帯の 2 行目に、見切れずに 1 行で出る長さ */
const SUMMARY_MAX_CHARS = 60;

/** 説明が、決まりの概要と見出しの並びに反していれば、その理由を返す */
function descriptionProblems(description: string): string[] {
  const problems: string[] = [];
  // 帯の 2 行目と同じく、最初の空行の手前までを 1 行にして（段落の中の改行は空白 1 つにして）数える
  const summary = firstParagraph(description);
  if (/^【[^】]+】/.test(description.trim())) problems.push("説明が見出しで始まっている（最初の段落は見出しなしの概要にする）");
  else if (/\n【[^】]+】/.test(description.trim().split(/\n[ \t　]*\n/)[0]!)) problems.push("概要のあとに空行を入れて、次の見出しと分ける");
  else if ([...summary].length > SUMMARY_MAX_CHARS) problems.push(`概要（説明の最初の段落）を ${SUMMARY_MAX_CHARS} 文字以内にする（いまは ${[...summary].length} 文字）`);
  // 本文の中で見出しの名前を引くこともあるので、行の頭にあるものだけを見出しとみなす
  const headings = [...description.matchAll(/^【([^】]+)】/gm)].map((m) => m[1]!);
  if (headings.join("→") !== DESCRIPTION_HEADINGS.join("→")) {
    problems.push(`説明の見出しの並びを ${DESCRIPTION_HEADINGS.map((h) => `【${h}】`).join("→")} にする（いまは ${headings.map((h) => `【${h}】`).join("→") || "見出しなし"}）`);
  }
  return problems;
}

/**
 * 何も変えない実行に、その線が何を表すかの名前（既定の「いまのまま」でないもの）と説明があるか。
 * 説明・シナリオの説明・注釈・要素の説明で、何も変えない実行を「元のモデル」と呼んでいないか
 */
function baselineProblems(model: ModelJSON): string[] {
  const problems: string[] = [];
  const b = model.baseline;
  if (!b?.name?.trim() || b.name.trim() === DEFAULT_BASELINE_NAME) {
    problems.push(`何も変えない実行に、何を表す線かの名前を付ける（set_scenarios の baseline.name。既定の「${DEFAULT_BASELINE_NAME}」のままにしない）`);
  }
  if (!b?.description?.trim()) problems.push("何も変えない実行に、何を表す線かの説明を付ける（set_scenarios の baseline.description）");
  const texts: [string, string | undefined][] = [
    ["モデルの説明", model.description],
    ...(model.scenarios ?? []).map((s): [string, string | undefined] => [`シナリオ「${s.name}」の説明`, s.description]),
    ...annotationsOf(model).map((a): [string, string | undefined] => [`注釈「${a.id}」`, a.text]),
    ...model.elements.map((e): [string, string | undefined] => [`要素「${e.name ?? `${e.from} → ${e.to}`}」の説明`, e.description]),
  ];
  for (const [where, text] of texts) {
    if (text?.includes("元のモデル")) problems.push(`${where}で「元のモデル」と呼んでいる（何も変えない実行の名前か、自然な言い方にする）`);
  }
  return problems;
}

/**
 * 注釈とモデルの説明でループを呼ぶ「R（口コミ）」のかっこの中が、loops に付けた名前になっているか。
 * 一覧の記号（R1 など）とは同じとは限らないので、番号を書かない（「B1（すぐ効く営業）」ではなく「B（すぐ効く営業）」）
 */
function loopNameProblems(model: ModelJSON): string[] {
  const problems: string[] = [];
  const names = wellFormedLoops(model).map((l) => l.name.toLowerCase());
  const texts: [string, string][] = [...annotationsOf(model).map((a): [string, string] => [`注釈「${a.id}」`, a.text]), ["モデルの説明", model.description ?? ""]];
  for (const [where, text] of texts) {
    for (const [, kind, number, name] of text.matchAll(/(?<![A-Za-z])([RB])(\d*)（([^）]+)）/g)) {
      if (number) problems.push(`${where}で ${kind}${number} と番号を書いている（番号は一覧の記号と同じとは限らないので、${kind}（${name}）と名前で呼ぶ）`);
      if (!names.includes(name!.toLowerCase())) problems.push(`${where}の ${kind}（${name}）の名前が、loops にない（set_loops で、そのループに同じ名前を付ける）`);
    }
  }
  return problems;
}

/** 実際のデータ（.data.csv）が、モデルと照らして問題のあるところ。なければ空 */
function dataProblems(model: ModelJSON, csv: string): string[] {
  try {
    return checkActualData(model, parseDataCSV(csv)).map((i) => `実際のデータ：${i.message}`);
  } catch (e) {
    return [`実際のデータが読めない：${(e as Error).message}`];
  }
}

/** モデルが sample の決まりに反しているところ（決まりごとに 1 行）。守っていれば空 */
function sampleProblems(model: ModelJSON): string[] {
  const problems: string[] = [];

  const v = validateModel(model, { trialRun: true });
  for (const i of v.errors) problems.push(`検証のエラー：${i.element ? `${i.element}：` : ""}${i.message}`);
  for (const i of v.warnings) problems.push(`検証の警告：${i.element ? `${i.element}：` : ""}${i.message}`);

  if (!model.description?.trim()) problems.push("モデルの説明（description）がない");
  else problems.push(...descriptionProblems(model.description));
  problems.push(...baselineProblems(model));
  problems.push(...loopNameProblems(model));

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
  // 検証でエラーがあれば何も変えない実行も動かないので、シナリオの実行は確かめない
  if (scenarios.length && !v.errors.length) {
    try {
      for (const run of runScenarios(model).scenarios) {
        if (run.error) problems.push(`シナリオ「${run.name}」が実行できない：${run.error.message}`);
      }
    } catch (e) {
      problems.push(`何も変えない実行が実行できない：${toModelError(e).message}`);
    }
  }

  const d = checkDiagram(model);
  if (d.missing_coordinates) problems.push("図の座標のない要素がある（layout_model などで座標を付ける）");
  for (const o of d.overlaps) problems.push(`図の重なり：${o}`);
  for (const l of d.lines_through_elements) problems.push(`線が要素の上を通る：${l}`);

  return problems;
}

/**
 * シナリオで変えるのは数字だけ（式を入れない）。式はシナリオの表にそのまま出て、長くて省略されるため。
 * 式で変えたいときは、数字のつまみになる変数をモデルに足す
 */
function scenarioValueProblems(model: ModelJSON): string[] {
  return (model.scenarios ?? []).flatMap((s) =>
    Object.entries(s.values)
      .filter(([, v]) => typeof v !== "number")
      .map(([name]) => `シナリオ「${s.name}」の「${name}」が数字でない（シナリオで変えるのは数字だけ。式で変えたいときは、数字のつまみになる変数をモデルに足す）`),
  );
}

/** シナリオに式が残っている sample（別の Issue で、数字のつまみに直す）。直したら外す */
const FORMULA_SCENARIOS_TO_FIX = new Set(["1_成長の限界/limits-to-growth.json"]);

/** 決まりを守った小さなモデル（コーヒーが冷める）。単体のテストで、ここから 1 つずつ壊す */
function goodModel(): ModelJSON {
  const m = emptyModel("coffee", { time_length: 60, time_units: "MINUTES" });
  m.description = ["熱いコーヒーは、部屋の温度に近づいて冷める。", ...DESCRIPTION_HEADINGS.map((h) => `【${h}】テスト用。`)].join("\n\n");
  upsertElements(m, [
    { type: "STOCK", name: "コーヒーの温度", behavior: { initial_value: 90 } },
    { type: "VARIABLE", name: "室温", behavior: { value: 20 } },
    { type: "FLOW", name: "冷める", from: "コーヒーの温度", to: null, behavior: { value: "([コーヒーの温度] - [室温]) * 0.1" } },
  ]);
  upsertElements(m, [
    { type: "LINK", from: "コーヒーの温度", to: "冷める", behavior: { polarity: "POSITIVE" } },
    { type: "LINK", from: "室温", to: "冷める", behavior: { polarity: "NEGATIVE" } },
  ]);
  setScenarios(m, [{ name: "寒い部屋", values: { 室温: 5 } }], { baseline: { name: "ふつうの部屋", description: "室温 20 ℃の部屋に置いたとき。" } });
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
    if (model && !FORMULA_SCENARIOS_TO_FIX.has(file)) problems.push(...scenarioValueProblems(model));
    const csv = path.join(EXAMPLES_DIR, file.replace(/\.json$/i, ".data.csv"));
    if (model && existsSync(csv)) problems.push(...dataProblems(model, readFileSync(csv, "utf8")));
    expect(problems, `examples/${file} が sample の決まり（examples/README.md）に反しています:\n${problems.join("\n")}`).toEqual([]);
  });

  test.each([...FORMULA_SCENARIOS_TO_FIX])("%s は、シナリオの式を直したら FORMULA_SCENARIOS_TO_FIX から外す", (file) => {
    const model = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, file), "utf8")) as ModelJSON;
    expect(scenarioValueProblems(model)).not.toEqual([]);
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

  test("説明は見出しなしの 60 文字以内の概要で始め、そのあと見出しを決まりの順に並べる", () => {
    const m = goodModel();
    expect(descriptionProblems(m.description!)).toEqual([]);
    // 本文の中で見出しの名前を引いても、見出しとは数えない
    expect(descriptionProblems(m.description!.replace("【もっと詳しく】テスト用。", "【もっと詳しく】（【どんな問題か】を参照）"))).toEqual([]);

    const headed = goodModel();
    headed.description = `【ひとことで】\n${headed.description}`;
    expect(sampleProblems(headed)).toEqual([
      "説明が見出しで始まっている（最初の段落は見出しなしの概要にする）",
      expect.stringContaining("いまは 【ひとことで】→【どんな問題か】"),
    ]);
    const noSummary = goodModel();
    noSummary.description = noSummary.description!.replace(/^[^\n]*\n\n/, "");
    expect(sampleProblems(noSummary)).toEqual(["説明が見出しで始まっている（最初の段落は見出しなしの概要にする）"]);
    const noBlankLine = goodModel();
    noBlankLine.description = noBlankLine.description!.replace("\n\n【どんな問題か】", "\n【どんな問題か】");
    expect(sampleProblems(noBlankLine)).toEqual(["概要のあとに空行を入れて、次の見出しと分ける"]);

    // 空白も 1 文字に数え、段落の中の改行は、帯と同じく空白 1 つにして数える
    const withSummary = (summary: string) => descriptionProblems(goodModel().description!.replace(/^[^\n]*/, summary));
    expect(withSummary("あ".repeat(60))).toEqual([]);
    expect(withSummary(`${"あ".repeat(30)} ${"あ".repeat(29)}`)).toEqual([]);
    expect(withSummary(`${"あ".repeat(30)} ${"あ".repeat(30)}`)).toEqual(["概要（説明の最初の段落）を 60 文字以内にする（いまは 61 文字）"]);
    expect(withSummary(`${"あ".repeat(30)}\n${"あ".repeat(30)}`)).toEqual(["概要（説明の最初の段落）を 60 文字以内にする（いまは 61 文字）"]);

    const swapped = goodModel();
    swapped.description = swapped.description!.replace("【どんな構造か】", "【X】").replace("【どんな問題か】", "【どんな構造か】").replace("【X】", "【どんな問題か】");
    expect(sampleProblems(swapped)).toEqual([expect.stringContaining("いまは 【どんな構造か】→【どんな問題か】")]);
    const missing = goodModel();
    missing.description = missing.description!.replace(/\n\n【もっと詳しく】テスト用。$/, "");
    expect(sampleProblems(missing)).toEqual([expect.stringContaining("見出しの並び")]);
  });

  test("何も変えない実行に名前と説明を付け、「元のモデル」と呼ばない", () => {
    const none = goodModel();
    delete none.baseline;
    expect(sampleProblems(none)).toEqual([expect.stringContaining("何を表す線かの名前を付ける"), expect.stringContaining("何を表す線かの説明を付ける")]);
    const named = goodModel();
    named.baseline = { name: DEFAULT_BASELINE_NAME, description: "説明" };
    expect(sampleProblems(named)).toEqual([expect.stringContaining(`既定の「${DEFAULT_BASELINE_NAME}」のままにしない`)]);

    const called = goodModel();
    called.description = called.description!.replace("【もっと詳しく】テスト用。", "【もっと詳しく】元のモデルより遅い。");
    called.scenarios![0]!.description = "元のモデルより寒い。";
    called.elements.find((e) => e.name === "室温")!.description = "元のモデルは 20。";
    called.annotations = [{ id: "読み方", text: "元のモデルと比べる。", coordinates: [0, 400] }];
    expect(baselineProblems(called)).toEqual([
      expect.stringMatching(/^モデルの説明で「元のモデル」/),
      expect.stringMatching(/^シナリオ「寒い部屋」の説明で「元のモデル」/),
      expect.stringMatching(/^注釈「読み方」で「元のモデル」/),
      expect.stringMatching(/^要素「室温」の説明で「元のモデル」/),
    ]);
  });

  test("実際のデータ（.data.csv）がモデルに合う", () => {
    const m = goodModel();
    expect(dataProblems(m, "Time,コーヒーの温度\n0,90\n10,60\n")).toEqual([]);
    expect(dataProblems(m, "Time,コーヒー\n0,90\n")).toEqual([expect.stringMatching(/^実際のデータ：.*"コーヒー"/)]);
    expect(dataProblems(m, "Time,コーヒーの温度\n100,90\n")).toEqual([expect.stringMatching(/^実際のデータ：.*重なりません/)]);
    expect(dataProblems(m, "")).toEqual([expect.stringMatching(/^実際のデータが読めない/)]);
  });

  test("極性のないリンクと、R か B か決まっていないループ", () => {
    const m = goodModel();
    linkOf(m, "コーヒーの温度", "冷める").behavior!.polarity = "NEUTRAL";
    expect(sampleProblems(m)).toEqual([
      "リンク コーヒーの温度 → 冷める に極性（behavior.polarity）がない",
      expect.stringMatching(/^R か B か決まっていないループがある/),
    ]);
  });

  test("注釈のループの名前（かっこの中）が loops にあり、番号を書いていない", () => {
    const m = goodModel();
    m.annotations = [{ id: "Bの読み方", text: "B（冷める）：熱いほど速く冷める。（‖）は遅れの印。B社（たとえ）", coordinates: [0, 400] }];
    expect(loopNameProblems(m)).toEqual([expect.stringMatching(/^注釈「Bの読み方」の B（冷める）の名前が、loops にない/)]);
    setLoops(m, [{ name: "冷める", elements: ["コーヒーの温度", "冷める"] }]);
    expect(loopNameProblems(m)).toEqual([]);
    m.annotations[0]!.text = "B1（冷める）：熱いほど速く冷める";
    expect(loopNameProblems(m)).toEqual([expect.stringMatching(/^注釈「Bの読み方」で B1 と番号を書いている/)]);
    m.annotations = [];
    m.description = `${m.description}\nR（ない輪）：説明でも同じ。`;
    expect(loopNameProblems(m)).toEqual([expect.stringMatching(/^モデルの説明の R（ない輪）の名前が、loops にない/)]);
  });

  test("シナリオがない、実行できないシナリオがある", () => {
    const none = goodModel();
    none.scenarios = [];
    expect(sampleProblems(none)).toEqual(["シナリオがない（てこのシナリオを 1 つ以上入れる）"]);
    const bad = goodModel();
    bad.scenarios = [{ name: "壊れた", values: { 室温: "[ない要素]" } }];
    expect(sampleProblems(bad)).toEqual([expect.stringMatching(/^シナリオ「壊れた」が実行できない/)]);
  });

  test("シナリオで変えるのは数字だけ（式を入れない）", () => {
    const m = goodModel();
    expect(scenarioValueProblems(m)).toEqual([]);
    m.scenarios = [{ name: "だんだん寒くなる", values: { 室温: "20 - Minutes() / 10" } }];
    expect(scenarioValueProblems(m)).toEqual([expect.stringMatching(/^シナリオ「だんだん寒くなる」の「室温」が数字でない/)]);
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
