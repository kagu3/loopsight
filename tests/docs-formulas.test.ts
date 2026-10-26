// 式の書き方のリファレンス（docs/reference/formulas.md）の例を、実際にモデルで動かして確かめる。
// エンジン（simulation）を更新して例が動かなくなったら、ここで気づけるようにする。
// 文書の決まり:
// - 表の「例」の列の式は、例のモデルの変数「例」の式として動かす。「要素の単位」の列があれば、変数の単位にする
// - 「例の値」が数だけ（「2.5」）なら、すべての時刻でその値になる。「、」で区切った数（「100、110、…、200」）なら、
//   … の前は初めからの値、… のあとは最後の値になる。ことばで書いた値は、このファイルの WORDED_VALUES と比べる
// - 表の「誤りになる式」の列の式は、誤りになり、その誤りに「出る誤り」の文が入る
// - 言語のない ``` のブロックは、変数「例」の式として動かす。```json のブロックは、要素の一覧として例のモデルに足して動かす。
//   どちらも値を BLOCK_VALUES、JSON_VALUES と比べる。ほかの言語のブロックは置かない
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ModelError, emptyModel, runModel, upsertElements, type ElementPatch, type ModelJSON, type SimulationSettings } from "../src/core/index.js";

const DOC = readFileSync(path.resolve("docs/reference/formulas.md"), "utf8");

/** 文書の「このページの例について」のモデル */
function exampleModel(simulation: SimulationSettings = {}): ModelJSON {
  const m = emptyModel("formulas", { time_start: 0, time_length: 10, time_step: 1, time_units: "YEARS", ...simulation });
  upsertElements(m, [
    { type: "STOCK", name: "人口", behavior: { initial_value: 100 } },
    { type: "VARIABLE", name: "出生率", behavior: { value: 0.1 } },
    { type: "FLOW", name: "出生", to: "人口", behavior: { value: "[人口] * [出生率]" } },
  ]);
  return m;
}

/** 変数「例」に式を入れて動かし、各時刻の値を返す */
function runExample(formula: string, units?: string, simulation?: SimulationSettings): unknown[] {
  const m = exampleModel(simulation);
  upsertElements(m, [{ type: "VARIABLE", name: "例", behavior: units ? { value: formula, units } : { value: formula } }]);
  return runModel(m).columns.get("例")!;
}

interface TableRow {
  header: string[];
  cells: string[];
  line: number;
}

/** 文書の表の行（見出しと区切りの行を除く）を、見出しと組にして返す */
function tableRows(doc: string): TableRow[] {
  const lines = doc.split(/\r?\n/);
  const rows: TableRow[] = [];
  let header: string[] | undefined;
  let fenced = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```")) fenced = !fenced;
    if (fenced || !line.startsWith("|")) {
      header = undefined;
      return;
    }
    const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (!header) header = cells;
    else if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push({ header, cells, line: i + 1 });
  });
  return rows;
}

/** セルの中の最初の `…` の中身 */
function codeIn(cell: string | undefined): string | undefined {
  return cell ? /`([^`]+)`/.exec(cell)?.[1] : undefined;
}

function cellOf(row: TableRow, name: string): string | undefined {
  const i = row.header.indexOf(name);
  return i < 0 ? undefined : row.cells[i];
}

/** 言語ごとの ``` のブロック */
function codeBlocks(doc: string): { lang: string; code: string; line: number }[] {
  const out: { lang: string; code: string; line: number }[] = [];
  const re = /^```(\w*)\r?\n([\s\S]*?)^```/gm;
  for (const m of doc.matchAll(re)) out.push({ lang: m[1]!, code: m[2]!.replace(/\r?\n$/, ""), line: doc.slice(0, m.index).split("\n").length });
  return out;
}

/** 「例の値」の数（"−" は負の記号として読む） */
function parseNumber(s: string): number | undefined {
  const t = s.trim().replace(/^−/, "-");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : undefined;
}

/** 書いてある桁で丸めて同じか */
function closeTo(actual: unknown, written: string): boolean {
  const n = parseNumber(written)!;
  const decimals = written.split(".")[1]?.length ?? 0;
  return typeof actual === "number" && Math.abs(actual - n) <= 0.5 * 10 ** -decimals + 1e-9;
}

/** 「例の値」を確かめる。確かめられない書き方なら false */
function checkWrittenValues(values: unknown[], written: string): boolean {
  if (parseNumber(written) !== undefined) {
    for (const v of values) expect(closeTo(v, written), `${JSON.stringify(values)} がすべて ${written}`).toBe(true);
    return true;
  }
  const parts = written.split("、").map((p) => p.trim());
  const dots = parts.indexOf("…");
  const head = dots < 0 ? parts : parts.slice(0, dots);
  const tail = dots < 0 ? [] : parts.slice(dots + 1);
  if (head.length < 2 || ![...head, ...tail].every((p) => parseNumber(p) !== undefined)) return false;
  if (dots < 0) expect(values).toHaveLength(head.length);
  head.forEach((p, i) => expect(closeTo(values[i], p), `${i} 番目の ${String(values[i])} が ${p}`).toBe(true));
  tail.forEach((p, i) => {
    const v = values[values.length - tail.length + i];
    expect(closeTo(v, p), `後ろから ${tail.length - i} 番目の ${String(v)} が ${p}`).toBe(true);
  });
  return true;
}

/** 値が同じか（小数は 0.01 まで）。expected が短ければ、初めからその数だけ比べる */
function expectValues(actual: unknown[], expected: number[]) {
  expected.forEach((e, i) => expect(Math.abs((actual[i] as number) - e), `${i} 番目の ${String(actual[i])} が ${e}`).toBeLessThanOrEqual(0.01));
}

/** 「例の値」をことばで書いた例の、0〜10 年の値 */
const WORDED_VALUES: Record<string, number[]> = {
  "[人口] <> 100": [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  "IfThenElse([人口] > 150 and Years() < 8, 1, 0)": [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0],
  "IfThenElse(Time() > {5 Years}, 1, 0)": [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
  "IfThenElse(Years() > 5, 1, 0)": [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
  "Max(0, 50 - [人口] * 0.2)": [30, 28, 25.8, 23.38, 20.72, 17.79, 14.57, 11.03, 7.13, 2.84, 0],
  "IfThenElse(Years() >= 3, Stop(), 0)": [0, 0, 0],
  "Step({3 Years}, 5)": [0, 0, 0, 5, 5, 5, 5, 5, 5, 5, 5],
  "Pulse({2 Years}, 5, 1)": [0, 0, 5, 5, 0, 0, 0, 0, 0, 0, 0],
  "Pulse({1 Years}, 3, 0, {4 Years})": [0, 3, 0, 0, 0, 3, 0, 0, 0, 3, 0],
  "Ramp({2 Years}, {6 Years}, 8)": [0, 0, 0, 2, 4, 6, 8, 8, 8, 8, 8],
  "Seasonal({6 Months})": [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
};

/** 言語のないブロック（1 行目で見分ける）の、0〜10 年の値 */
const BLOCK_VALUES: Record<string, number[]> = {
  "[人口] * 0.5 # 半分にする": [50, 55, 60.5, 66.55, 73.21, 80.53, 88.58, 97.44, 107.18, 117.9, 129.69],
  "if Years() < 2 then": [10, 10, 20, 30, 30, 30, 30, 30, 30, 30, 30],
  "半分 <- [人口] * 0.5": [51, 56, 61.5, 67.55, 74.21, 81.53, 89.58, 98.44, 108.18, 118.9, 130.69],
};

/** json のブロック（初めの要素の名前で見分ける）で確かめる要素と、初めからの値 */
const JSON_VALUES: Record<string, Record<string, number[]>> = {
  価格表: { 価格表: [10, 20, 30, 25, 20, 20, 20, 20, 20, 20, 20], 例: [20, 40, 60, 50, 40, 40, 40, 40, 40, 40, 40] },
  混み具合: { 混み具合: [1, 0.95, 0.895, 0.8345, 0.768, 0.6947, 0.6142, 0.5256, 0.5, 0.5, 0.5] },
  在庫: { 在庫: [10, 11, 12.1, 13.31, 14.64, 16.11, 17.72, 19.49, 21.44, 23.58, 25.94] },
};

const rows = tableRows(DOC);
const examples = rows.filter((r) => codeIn(cellOf(r, "例")));
const errorExamples = rows.filter((r) => codeIn(cellOf(r, "誤りになる式")));
const blocks = codeBlocks(DOC);

describe("式の書き方の文書の例", () => {
  test("文書から例を読み取れる", () => {
    expect(examples.length).toBeGreaterThan(50);
    expect(errorExamples.length).toBeGreaterThanOrEqual(5);
    expect(blocks.filter((b) => b.lang === "").length).toBeGreaterThanOrEqual(3);
    expect(blocks.filter((b) => b.lang === "json").length).toBeGreaterThanOrEqual(3);
  });

  test.each(examples.map((r) => [`${r.line} 行目: ${codeIn(cellOf(r, "例"))}`, r] as const))("表の例 %s が動く", (_, row) => {
    const formula = codeIn(cellOf(row, "例"))!;
    const units = codeIn(cellOf(row, "要素の単位"));
    const values = runExample(formula, units);
    expect(values).not.toHaveLength(0);
    for (const v of values) expect(typeof v === "number" && Number.isFinite(v), `${formula} の値 ${String(v)} が数`).toBe(true);
    const written = cellOf(row, "例の値");
    if (written && !checkWrittenValues(values, written)) {
      // ことばで書いた値は、決めた値と比べる
      expect(WORDED_VALUES[formula], `${formula} の値を WORDED_VALUES に足す`).toBeDefined();
      expectValues(values, WORDED_VALUES[formula]!);
    }
  });

  test("「例の値」をことばで書いた例は、決めた一覧と同じ（増えたら値を一覧に足す）", () => {
    const worded = examples
      .filter((r) => {
        const written = cellOf(r, "例の値");
        return written && !checkWrittenValues(runExample(codeIn(cellOf(r, "例"))!, codeIn(cellOf(r, "要素の単位"))), written);
      })
      .map((r) => codeIn(cellOf(r, "例"))!);
    expect(worded.sort()).toEqual(Object.keys(WORDED_VALUES).sort());
  });

  test.each(errorExamples.map((r) => [`${r.line} 行目: ${codeIn(cellOf(r, "誤りになる式"))}`, r] as const))("誤りの例 %s が、書いてある誤りになる", (_, row) => {
    const formula = codeIn(cellOf(row, "誤りになる式"))!;
    const units = codeIn(cellOf(row, "要素の単位"));
    const message = codeIn(cellOf(row, "出る誤り"))!;
    try {
      runExample(formula, units);
      expect.unreachable(`${formula} は誤りになるはず`);
    } catch (e) {
      expect(e).toBeInstanceOf(ModelError);
      const text = (e as ModelError).issues.map((i) => i.message).join("\n");
      expect(text).toContain(message);
    }
  });

  test("コードのブロックは、言語なしか json だけ", () => {
    expect(blocks.filter((b) => b.lang !== "" && b.lang !== "json").map((b) => `${b.line} 行目: ${b.lang}`)).toEqual([]);
  });

  test.each(blocks.filter((b) => b.lang === "").map((b) => [`${b.line} 行目`, b.code] as const))("式のブロック（%s）が動き、決めた値になる", (_, code) => {
    const firstLine = code.split("\n")[0]!;
    expect(BLOCK_VALUES[firstLine], `「${firstLine}」の値を BLOCK_VALUES に足す`).toBeDefined();
    expectValues(runExample(code), BLOCK_VALUES[firstLine]!);
  });

  test.each(blocks.filter((b) => b.lang === "json").map((b) => [`${b.line} 行目`, b.code] as const))("要素の一覧のブロック（%s）が動き、決めた値になる", (_, code) => {
    const elements = JSON.parse(code) as ElementPatch[];
    const first = elements[0]!.name!;
    expect(JSON_VALUES[first], `「${first}」で始まるブロックの値を JSON_VALUES に足す`).toBeDefined();
    const m = exampleModel();
    upsertElements(m, elements);
    const data = runModel(m);
    expect(data.times).toHaveLength(11);
    for (const [name, values] of Object.entries(JSON_VALUES[first]!)) expectValues(data.columns.get(name)!, values);
  });
});

describe("式の書き方の文書の説明", () => {
  function expectError(elements: ElementPatch[], message: string) {
    const m = exampleModel();
    upsertElements(m, elements);
    try {
      runModel(m);
      expect.unreachable();
    } catch (e) {
      const err = e as ModelError & { issues?: { message: string }[] };
      expect([err.message, ...(err.issues ?? []).map((i) => i.message)].join("\n")).toContain(message);
    }
    expect(DOC).toContain(message);
  }

  test("入力にほかの要素を使うコンバーターは、リンクがないと誤りになる", () => {
    expectError(
      [{ type: "CONVERTER", name: "混み具合", behavior: { input: "ELEMENT", input_element: "人口", data: [[100, 1], [200, 0.5]], interpolation: "LINEAR" } }],
      'Converter input element "人口" is not connected to the converter "混み具合".',
    );
  });

  test("ストックに単位があってフローの単位がないと誤りになる", () => {
    expectError(
      [
        { type: "STOCK", name: "在庫", behavior: { initial_value: "10", units: "Widgets" } },
        { type: "FLOW", name: "入荷", to: "在庫", behavior: { value: "2" } },
      ],
      "Incompatible units for flow [入荷] and connected stock [在庫].",
    );
  });

  test("変数どうしが互いに参照し合うと誤りになる", () => {
    expectError(
      [
        { type: "VARIABLE", name: "A", behavior: { value: "[B] + 1" } },
        { type: "VARIABLE", name: "B", behavior: { value: "[A] + 1" } },
      ],
      "Circular equation loop identified",
    );
  });

  test("名前の前後に空白を入れると、要素が見つからない", () => {
    expect(() => runExample("[出生率 ] * 2")).toThrow(ModelError);
    expect(runExample("[出生率] * 2")[0]).toBe(0.2);
  });

  test("名前と関数の名前は、大文字と小文字を区別しない", () => {
    const m = exampleModel();
    upsertElements(m, [
      { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.2 } },
      { type: "VARIABLE", name: "例", behavior: { value: "ifthenelse(years() > 5, [birth rate], 0)" } },
    ]);
    expect(runModel(m).columns.get("例")!.at(-1)).toBe(0.2);
  });

  test("Years() は時間の単位が月でも年で数え、開始の時刻から数える", () => {
    expect(runExample("Years()", undefined, { time_units: "MONTHS", time_length: 12 }).at(-1)).toBeCloseTo(1);
    expect(runExample("Years()", undefined, { time_start: 2020 })[0]).toBe(2020);
  });

  test("刻み幅 1 年の Delay3([人口], {2 Years}) は揺れ、0.25 年ならなめらかに増える", () => {
    const coarse = runExample("Delay3([人口], {2 Years})") as number[];
    expect(coarse.slice(4, 7).map((v) => Number(v.toFixed(2)))).toEqual([133.75, 120.25, 156.03]);
    const fine = runExample("Delay3([人口], {2 Years})", undefined, { time_step: 0.25 }) as number[];
    fine.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(fine[i]!));
  });

  test("ストックの初期値は始まりに 1 回だけ計算する", () => {
    const m = exampleModel();
    upsertElements(m, [
      { type: "STOCK", name: "半分", behavior: { initial_value: "[人口] / 2" } },
      { type: "STOCK", name: "乱数", behavior: { initial_value: "Rand(0, 10)" } },
      { type: "STOCK", name: "時間の関数", behavior: { initial_value: "Delay([人口], {1 Years}, 5) + Step({0 Years}, 3)" } },
    ]);
    const data = runModel(m);
    expect(new Set(data.columns.get("半分"))).toEqual(new Set([50]));
    expect(new Set(data.columns.get("乱数")).size).toBe(1);
    expect(data.columns.get("時間の関数")![0]).toBe(8);
  });

  test("流量 × 刻み幅だけストックが変わり、負にしないを付けると 0 で止まる", () => {
    const m = exampleModel({ time_step: 0.5, time_length: 2 });
    upsertElements(m, [
      { type: "STOCK", name: "S", behavior: { initial_value: 0 } },
      { type: "FLOW", name: "入", to: "S", behavior: { value: 10 } },
      { type: "STOCK", name: "T", behavior: { initial_value: 5, non_negative: true } },
      { type: "FLOW", name: "出", from: "T", behavior: { value: 4 } },
      { type: "STOCK", name: "U", behavior: { initial_value: 5 } },
      { type: "FLOW", name: "負の流量", to: "U", behavior: { value: -2 } },
      { type: "STOCK", name: "V", behavior: { initial_value: 5 } },
      { type: "FLOW", name: "負にしない流量", to: "V", behavior: { value: -2, non_negative: true } },
    ]);
    const data = runModel(m);
    expect(data.columns.get("S")).toEqual([0, 5, 10, 15, 20]);
    expect(data.columns.get("T")!.at(-1)).toBe(0);
    expect(data.columns.get("U")!.at(-1)).toBe(1);
    expect(data.columns.get("V")!.at(-1)).toBe(5);
  });

  test("フローの単位の時間はエンジンが変換する（年のモデルで 2 Widgets/Month は 1 年で 24）", () => {
    const m = exampleModel({ time_length: 1 });
    upsertElements(m, [
      { type: "STOCK", name: "在庫", behavior: { initial_value: "10", units: "Widgets" } },
      { type: "FLOW", name: "入荷", to: "在庫", behavior: { value: "2", units: "Widgets/Month" } },
    ]);
    expect(runModel(m).columns.get("在庫")).toEqual([10, 34]);
  });

  test("Stop() で終え、Pause() は何もしない", () => {
    expect(runExample("IfThenElse(Years() >= 3, Stop(), 0)")).toHaveLength(3);
    expect(runExample("IfThenElse(Years() = 1, Pause(), 0)")).toEqual(Array(11).fill(0));
  });

  test("使えない関数は誤りになる", () => {
    for (const f of ["[人口].FindAll()", "[人口].PopulationSize()", "FindState([人口], 1)", "Move([人口], 1)"]) {
      expect(() => runExample(f), f).toThrow(ModelError);
    }
    for (const f of ['Alert("a")', 'Prompt("a")', 'Confirm("a")']) {
      try {
        runExample(f);
        expect.unreachable(f);
      } catch (e) {
        expect((e as ModelError).issues[0]!.message).toContain("is not implemented on this platform");
      }
    }
  });
});
