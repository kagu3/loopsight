// examples/ の sample の説明に書いた要の数字が、シミュレーションの結果と合っているかを確かめる。
// エンジンや式を変えたときに、説明の数字が黙ってずれないようにする。
// 表は人が書く（説明文から数字を自動で読み取るのは壊れやすい）。説明の要の数字を変えたら、この表も直す
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runScenarios, toModelError, type ModelJSON, type RunData } from "../src/core/index.js";

const EXAMPLES_DIR = path.resolve("examples");

/** 説明の数字 1 つ。value は説明に書いた書き方のまま（「2,769」「45.0」）。読み方は what のどれか 1 つ */
interface KeyNumber {
  /** examples/ からの相対パス */
  model: string;
  /** シナリオの名前。なければ「元のモデル」 */
  scenario?: string;
  element: string;
  /** element ÷ per の値を見る（注文 ÷ 需要 など） */
  per?: string;
  /** 何を見るか。at：その時刻の値、peak：最大値（at があればその時刻も）、firstBelow：値が初めてこれを下回る時刻 */
  what: { at: number } | { peak: true; at?: number } | { firstBelow: number };
  /** 説明に書いた値（書き方のまま） */
  value: string;
  /** 説明（モデルの説明か、シナリオの説明）にそのまま書いてある、value を含む言葉。なければ value そのもの */
  text?: string;
}

const KEY_NUMBERS: KeyNumber[] = [
  // 0 コーヒーが冷める
  { model: "0_コーヒーが冷める/coffee-cooling.json", element: "コーヒーの温度", what: { at: 60 }, value: "45.0", text: "1 時間後は 45.0 ℃" },
  { model: "0_コーヒーが冷める/coffee-cooling.json", element: "コーヒーの温度", what: { at: 120 }, value: "28.0", text: "2 時間後でも 28.0 ℃" },
  { model: "0_コーヒーが冷める/coffee-cooling.json", scenario: "保温マグにする", element: "コーヒーの温度", what: { at: 60 }, value: "68.4", text: "45.0 ℃ → 68.4 ℃" },
  { model: "0_コーヒーが冷める/coffee-cooling.json", scenario: "夏の部屋", element: "コーヒーの温度", what: { at: 60 }, value: "51.8", text: "1 時間後は 51.8 ℃" },
  // 1 成長の限界
  { model: "1_成長の限界/limits-to-growth.json", element: "使っている人", what: { at: 24 }, value: "9,600", text: "24 か月目には約 9,600 人" },
  { model: "1_成長の限界/limits-to-growth.json", scenario: "営業を 10 倍にする", element: "使っている人", what: { at: 36 }, value: "9,994", text: "36 か月目は 9,994 人" },
  { model: "1_成長の限界/limits-to-growth.json", scenario: "新しい市場に出る", element: "使っている人", what: { at: 36 }, value: "19,948", text: "36 か月目に 19,948 人" },
  // 2 うまくいかない解決策（残りが 10 タスクを切る週）
  { model: "2_うまくいかない解決策/fixes-that-fail.json", element: "残っている仕事", what: { firstBelow: 10 }, value: "30.25", text: "残業ありが 30.25 週目" },
  { model: "2_うまくいかない解決策/fixes-that-fail.json", scenario: "残業しない", element: "残っている仕事", what: { firstBelow: 10 }, value: "28.25", text: "残業しないが 28.25 週目" },
  { model: "2_うまくいかない解決策/fixes-that-fail.json", scenario: "予定を引き直す（28 週）", element: "残っている仕事", what: { firstBelow: 10 }, value: "28.25", text: "28.25 週目に終わり" },
  { model: "2_うまくいかない解決策/fixes-that-fail.json", scenario: "仕事の量を減らす（700 タスク）", element: "残っている仕事", what: { firstBelow: 10 }, value: "19.75", text: "19.75 週目に終わる" },
  // 3 問題のすり替わり（60 か月目の売上）
  { model: "3_問題のすり替わり/shifting-the-burden.json", element: "売上", what: { at: 60 }, value: "31", text: "元のモデルが 31" },
  { model: "3_問題のすり替わり/shifting-the-burden.json", scenario: "品質に回す", element: "売上", what: { at: 60 }, value: "76", text: "品質に回すが 76" },
  { model: "3_問題のすり替わり/shifting-the-burden.json", scenario: "営業に強く頼る", element: "売上", what: { at: 60 }, value: "20", text: "60 か月で 20 になる" },
  { model: "3_問題のすり替わり/shifting-the-burden.json", scenario: "予算の残りをすべて品質に回す", element: "売上", what: { at: 60 }, value: "81.8", text: "60 か月で 81.8" },
  // 4 エスカレート（52 週目）
  { model: "4_エスカレート/advertising-war.json", element: "A社の広告費", what: { at: 52 }, value: "29.9", text: "52 週で約 29.9" },
  { model: "4_エスカレート/advertising-war.json", scenario: "A社が12週目に競り合いをやめる", element: "A社の利益", what: { at: 52 }, value: "25.8", text: "A社 約 25.8" },
  { model: "4_エスカレート/advertising-war.json", scenario: "A社が12週目に競り合いをやめる", element: "B社の利益", what: { at: 52 }, value: "24.4", text: "B社 約 24.4" },
  { model: "4_エスカレート/advertising-war.json", scenario: "A社が相手に合わせるだけにする", element: "A社の広告費", what: { at: 52 }, value: "19.4", text: "A社 約 19.4" },
  // 5 成長と投資不足（120 か月目）
  { model: "5_成長と投資不足/growth-and-underinvestment.json", element: "注文", what: { at: 120 }, value: "2,769", text: "120 か月目の注文は 2,769 台/月" },
  { model: "5_成長と投資不足/growth-and-underinvestment.json", element: "注文", per: "市場の需要", what: { at: 120 }, value: "0.63", text: "0.63（120 か月目）" },
  { model: "5_成長と投資不足/growth-and-underinvestment.json", scenario: "目標を守る", element: "注文", what: { at: 120 }, value: "5,576", text: "120 か月目の注文は 5,576 台/月" },
  { model: "5_成長と投資不足/growth-and-underinvestment.json", scenario: "先に投資する", element: "注文", what: { at: 120 }, value: "6,598", text: "6,598 台/月" },
  // 6 ブルウィップ効果（工場の生産指示の山）
  { model: "6_ブルウィップ効果/bullwhip.json", element: "工場の生産指示", what: { peak: true, at: 13 }, value: "533", text: "13 週目に約 533" },
  { model: "6_ブルウィップ効果/bullwhip.json", scenario: "在庫をゆっくり戻す", element: "工場の生産指示", what: { peak: true }, value: "177", text: "約 177" },
  { model: "6_ブルウィップ効果/bullwhip-countermeasures.json", element: "工場の生産指示", what: { peak: true, at: 13 }, value: "533", text: "13 週目に約 533" },
  { model: "6_ブルウィップ効果/bullwhip-countermeasures.json", scenario: "B 届いていない注文も数える", element: "工場の生産指示", what: { peak: true }, value: "220", text: "約 220" },
  { model: "6_ブルウィップ効果/bullwhip-countermeasures.json", scenario: "C 売れ行きを共有する", element: "工場の生産指示", what: { peak: true }, value: "349", text: "約 349" },
  { model: "6_ブルウィップ効果/bullwhip-countermeasures.json", scenario: "B+C 数える＋共有する", element: "工場の生産指示", what: { peak: true }, value: "149", text: "約 149" },
];

/** 説明の書き方の値と、許す誤差。1% か、書いた桁の半分（2.0 なら 0.05）の大きいほう。時刻を答える行は、この誤差ではなく刻みで比べる */
function written(value: string): { value: number; tolerance: number } {
  const n = Number(value.replace(/,/g, ""));
  const decimals = value.split(".")[1]?.length ?? 0;
  return { value: n, tolerance: Math.max(Math.abs(n) * 0.01, 0.5 * 10 ** -decimals) };
}

/** 結果から、表の 1 行が見る値を読む。合わないところ（説明の値といくつ違うか）を返す。合っていれば空 */
function numberProblems(k: KeyNumber, data: RunData): string[] {
  const series = (name: string) => {
    const col = data.columns.get(name);
    if (!col) throw new Error(`要素「${name}」が結果にない`);
    return col.map(Number);
  };
  const ys = series(k.element);
  const values = k.per ? ys.map((y, i) => y / series(k.per!)[i]!) : ys;
  const label = k.per ? `${k.element} ÷ ${k.per}` : k.element;
  const indexAt = (t: number) => {
    const i = data.times.findIndex((x) => Math.abs(x - t) < 1e-9);
    if (i < 0) throw new Error(`時刻 ${t} が結果にない`);
    return i;
  };
  // 時刻は刻みごとにしか出ないので、刻みの半分未満の差（同じ刻み）だけを許す
  const step = data.times.length > 1 ? data.times[1]! - data.times[0]! : 1;
  const timeProblem = (what: string, expected: number, actual: number) =>
    Math.abs(actual - expected) < step / 2 ? [] : [`${what}：説明は ${expected}、結果は ${actual}（刻みは ${step}）`];

  let actual: number;
  let what: string;
  const problems: string[] = [];
  if ("firstBelow" in k.what) {
    const i = values.findIndex((v) => v < (k.what as { firstBelow: number }).firstBelow);
    what = `${label}が ${k.what.firstBelow} を初めて下回る時刻`;
    if (i < 0) return [`${what}：期間の中で下回らない（説明は ${k.value}）`];
    return timeProblem(what, written(k.value).value, data.times[i]!);
  } else if ("peak" in k.what) {
    const i = values.reduce((best, v, j) => (v > values[best]! ? j : best), 0);
    actual = values[i]!;
    what = `${label}の最大値`;
    if (k.what.at !== undefined) problems.push(...timeProblem(`${what}の時刻`, k.what.at, data.times[i]!));
  } else {
    actual = values[indexAt(k.what.at)]!;
    what = `${label}（時刻 ${k.what.at}）`;
  }
  const w = written(k.value);
  const diff = actual - w.value;
  if (!(Math.abs(diff) <= w.tolerance)) {
    problems.push(`${what}：説明は ${k.value}、結果は ${round(actual)}（${diff > 0 ? "+" : ""}${round(diff)}、${round((diff / w.value) * 100)}%）`);
  }
  return problems;
}

const round = (x: number) => Number(x.toPrecision(4));

const models = new Map<string, ModelJSON>();
function modelOf(file: string): ModelJSON {
  if (!models.has(file)) models.set(file, JSON.parse(readFileSync(path.join(EXAMPLES_DIR, file), "utf8")) as ModelJSON);
  return models.get(file)!;
}

const runs = new Map<string, ReturnType<typeof runScenarios>>();
/** 「試しの実行」と同じく、モデルのシミュレーションの設定と保存したシナリオで動かす */
function runOf(file: string): ReturnType<typeof runScenarios> {
  if (!runs.has(file)) runs.set(file, runScenarios(modelOf(file)));
  return runs.get(file)!;
}

/** 表の 1 行が、説明と結果に合わないところ */
function keyNumberProblems(k: KeyNumber): string[] {
  const model = modelOf(k.model);
  const text = k.text ?? k.value;
  const problems: string[] = [];
  if (!text.includes(k.value)) problems.push(`表の text「${text}」に value「${k.value}」が入っていない`);
  // シナリオの行は、そのシナリオの説明かモデルの説明から探す。元のモデルの行は、モデルの説明とすべてのシナリオの説明から探す
  const scenarios = (model.scenarios ?? []).filter((s) => !k.scenario || s.name === k.scenario);
  const descriptions = [model.description ?? "", ...scenarios.map((s) => s.description ?? "")];
  if (!descriptions.some((d) => d.includes(text))) problems.push(`説明に「${text}」がない（説明の数字を変えたら、この表も直す）`);

  let run: ReturnType<typeof runScenarios>;
  try {
    run = runOf(k.model);
  } catch (e) {
    return [...problems, `元のモデルが実行できない：${toModelError(e).message}`];
  }
  let data: RunData | undefined = run.baseline;
  if (k.scenario) {
    const s = run.scenarios.find((x) => x.name === k.scenario);
    if (!s) return [...problems, `シナリオ「${k.scenario}」がない`];
    if (s.error) return [...problems, `シナリオ「${k.scenario}」が実行できない：${s.error.message}`];
    data = s.data;
  }
  try {
    problems.push(...numberProblems(k, data!));
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

describe("sample の説明の要の数字が、シミュレーションの結果と合う", () => {
  const byModel = Map.groupBy(KEY_NUMBERS, (k) => k.model);

  test.each([...byModel.keys()])("%s", (file) => {
    const problems = byModel.get(file)!.flatMap((k) =>
      keyNumberProblems(k).map((p) => `${k.scenario ?? "元のモデル"}「${k.text ?? k.value}」：${p}`),
    );
    expect(problems, `examples/${file} の説明の数字が、結果と合いません:\n${problems.join("\n")}`).toEqual([]);
  });

  test("どのモデルにも、要の数字が 2〜4 つある", () => {
    const files = readdirSync(EXAMPLES_DIR, { recursive: true, encoding: "utf8" })
      .map((f) => f.split(path.sep).join("/"))
      .filter((f) => f.toLowerCase().endsWith(".json"));
    const counts = Object.fromEntries(files.map((f) => [f, byModel.get(f)?.length ?? 0]));
    expect(Object.entries(counts).filter(([, n]) => n < 2 || n > 4), "表（KEY_NUMBERS）の行の数").toEqual([]);
  });
});

describe("説明の数字の判定", () => {
  const data: RunData = {
    timeUnits: "Weeks",
    times: [0, 1, 2, 3],
    columns: new Map<string, unknown[]>([
      ["在庫", [100, 50, 5, 0]],
      ["発注", [10, 40, 20, 10]],
      ["需要", [20, 20, 20, 20]],
    ]),
  };
  const row = (r: Partial<KeyNumber>): KeyNumber => ({ model: "m.json", element: "在庫", what: { at: 1 }, value: "50", ...r });

  test("書いた桁に合わせて誤差を許す：1% か、桁の半分の大きいほう", () => {
    expect(written("2,769")).toEqual({ value: 2769, tolerance: 27.69 });
    expect(written("2.0")).toEqual({ value: 2, tolerance: 0.05 });
  });

  test("その時刻の値、割った値、最大値とその時刻、初めて下回る時刻", () => {
    expect(numberProblems(row({}), data)).toEqual([]);
    expect(numberProblems(row({ value: "50.4" }), data)).toEqual([]);
    expect(numberProblems(row({ element: "発注", per: "需要", value: "2.0" }), data)).toEqual([]);
    expect(numberProblems(row({ element: "発注", what: { peak: true, at: 1 }, value: "40" }), data)).toEqual([]);
    expect(numberProblems(row({ what: { firstBelow: 10 }, value: "2" }), data)).toEqual([]);
  });

  test("ずれたら、説明の値と結果と、いくつ違うかを出す", () => {
    expect(numberProblems(row({ value: "52" }), data)).toEqual(["在庫（時刻 1）：説明は 52、結果は 50（-2、-3.846%）"]);
    expect(numberProblems(row({ element: "発注", what: { peak: true, at: 2 }, value: "40" }), data)).toEqual([
      "発注の最大値の時刻：説明は 2、結果は 1（刻みは 1）",
    ]);
    expect(numberProblems(row({ what: { firstBelow: -1 }, value: "2" }), data)).toEqual([
      expect.stringContaining("期間の中で下回らない"),
    ]);
    expect(() => numberProblems(row({ element: "ない" }), data)).toThrow(/要素「ない」/);
  });

  test("時刻を答える行は、1% ではなく刻み（ここでは 1）で比べる", () => {
    // 1% なら 100 に対して ±1 を許してしまうが、時刻は 1 刻みでもずれたら落とす
    const long: RunData = { ...data, times: [98, 99, 100, 101] };
    expect(numberProblems(row({ what: { firstBelow: 10 }, value: "100" }), long)).toEqual([]);
    expect(numberProblems(row({ what: { firstBelow: 10 }, value: "101" }), long)).toEqual(["在庫が 10 を初めて下回る時刻：説明は 101、結果は 100（刻みは 1）"]);
    expect(numberProblems(row({ element: "発注", what: { peak: true, at: 100 }, value: "40" }), long)).toEqual([
      "発注の最大値の時刻：説明は 100、結果は 99（刻みは 1）",
    ]);
  });
});
