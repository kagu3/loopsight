// docs/reference/model-format.md の書き漏れを防ぐ。
// コードの一覧（loopsight が足した項目、使う公式の項目、起動引数と環境変数）と、文書の表の 1 列目を突き合わせる
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadModelJSON } from "simulation";
import { describe, expect, test } from "vitest";
import {
  ENV_VARS,
  LOOPSIGHT_DISPLAY_KEYS,
  LOOPSIGHT_FIELDS,
  LOOPSIGHT_MODEL_KEYS,
  MCP_OPTIONS,
  MODELJSON_FIELDS,
  VIEWER_OPTIONS,
  emptyModel,
  engineModel,
  upsertElements,
  type ModelJSON,
} from "../src/core/index.js";

const DOC = "docs/reference/model-format.md";
const text = readFileSync(path.resolve(DOC), "utf8");

/** 見出し（## …）の節にある表の、1 列目の `…` を並べる */
function tableKeys(heading: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`${DOC} に「## ${heading}」の見出しがありません。`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .map((l) => /^\|\s*`([^`]+)`\s*\|/.exec(l)?.[1])
    .filter((k): k is string => !!k);
}

/** コードの一覧と文書の表を比べ、足りないものと余計なものを、直す文書とあわせて知らせる */
function expectSame(heading: string, code: readonly string[], where: string) {
  const doc = tableKeys(heading);
  const missing = code.filter((k) => !doc.includes(k));
  const extra = doc.filter((k) => !code.includes(k));
  expect(missing, `${DOC} の「${heading}」の表に、次の項目を書いてください（一覧は ${where}）: ${missing.join("、")}`).toEqual([]);
  expect(extra, `${DOC} の「${heading}」の表に、コードにない項目があります。消すか、${where} に足してください: ${extra.join("、")}`).toEqual([]);
  expect(new Set(doc).size, `${DOC} の「${heading}」の表に、同じ項目が 2 回あります`).toBe(doc.length);
}

describe("docs/reference/model-format.md", () => {
  test("loopsight が足した項目がすべて書いてあり、余計なものがない", () => {
    expectSame("loopsight が足した項目", LOOPSIGHT_FIELDS, "src/core/modeljson.ts の LOOPSIGHT_FIELDS");
  });

  test("使う公式の項目がすべて書いてあり、余計なものがない", () => {
    expectSame("使う公式の項目", MODELJSON_FIELDS, "src/core/modeljson.ts の MODELJSON_FIELDS");
  });

  test("起動引数と環境変数がすべて書いてあり、余計なものがない", () => {
    const code = [...new Set([...Object.keys(MCP_OPTIONS), ...Object.keys(VIEWER_OPTIONS)].map((k) => `--${k}`)), ...Object.values(ENV_VARS)];
    expectSame("起動引数と環境変数", code, "src/core/options.ts");
  });

  test("src/ の中で環境変数を src/core/options.ts の ENV_VARS を通さずに読んでいない", () => {
    // process.env.NAME や process.env["NAME"] と直接書くと、環境変数を足しても上のテストで書き忘れに気づけない
    const direct = /process\.env\s*(\.\s*[A-Za-z_$]|\[\s*["'`])/;
    const found = readdirSync(path.resolve("src"), { recursive: true, encoding: "utf8" })
      .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
      .flatMap((f) =>
        readFileSync(path.resolve("src", f), "utf8")
          .split(/\r?\n/)
          .flatMap((line, i) => (direct.test(line) ? [`src/${f.split(path.sep).join("/")}:${i + 1}`] : [])),
      );
    expect(found, `環境変数は src/core/options.ts の ENV_VARS に足し、process.env[ENV_VARS.…] で読んでください: ${found.join("、")}`).toEqual([]);
  });

  test("公式の項目と loopsight が足した項目は重ならない", () => {
    expect(LOOPSIGHT_FIELDS.filter((k) => MODELJSON_FIELDS.includes(k))).toEqual([]);
  });
});

describe("loopsight が足した項目とエンジン", () => {
  /** loopsight が足した項目をすべて使ったモデル */
  function withAll(): ModelJSON {
    const m = emptyModel("all");
    upsertElements(m, [
      { type: "STOCK", name: "在庫", behavior: { initial_value: 10 }, display: { emphasis: true } },
      { type: "VARIABLE", name: "発注", behavior: { value: "[在庫]" } },
    ]);
    upsertElements(m, [{ type: "LINK", from: "在庫", to: "発注", behavior: { polarity: "POSITIVE" }, display: { delay: true } }]);
    m.groups = [{ name: "お店側", color: "yellow", elements: ["在庫"] }];
    m.annotations = [{ id: "n1", text: "メモ", coordinates: [0, 0], width: 200 }];
    m.scenarios = [{ name: "多め", values: { 在庫: 20 } }];
    return m;
  }

  test("一覧の項目をすべて使っている（テストのモデルが一覧とずれていない）", () => {
    const m = withAll();
    for (const k of LOOPSIGHT_MODEL_KEYS) expect(m).toHaveProperty(k);
    for (const k of LOOPSIGHT_DISPLAY_KEYS) expect(m.elements.some((e) => e.display && k in e.display)).toBe(true);
  });

  test("そのままではエンジン（loadModelJSON）が知らない項目としてエラーにする", () => {
    const m = withAll();
    for (const k of LOOPSIGHT_MODEL_KEYS) {
      const only = engineModel(m);
      (only as Record<string, unknown>)[k] = (m as Record<string, unknown>)[k];
      expect(() => loadModelJSON(only), k).toThrow(`Invalid property "${k}"`);
    }
    for (const k of LOOPSIGHT_DISPLAY_KEYS) {
      const only = engineModel(m);
      const i = m.elements.findIndex((e) => e.display && k in e.display);
      only.elements = only.elements.map((e, j) => (j === i ? { ...e, display: { ...e.display, [k]: m.elements[i]!.display![k] } } : e));
      expect(() => loadModelJSON(only), k).toThrow(`Invalid property "${k}"`);
    }
  });

  test("engineModel で取り除くと読み込め、公式の項目（scenarios、polarity）は残る", () => {
    const m = withAll();
    const e = engineModel(m);
    expect(() => loadModelJSON(e)).not.toThrow();
    expect(e.scenarios).toEqual(m.scenarios);
    expect(e.elements.find((x) => x.type === "LINK")?.behavior?.polarity).toBe("POSITIVE");
    // もとのモデルは変えない
    expect(m.groups).toHaveLength(1);
    expect(m.elements[0]!.display?.emphasis).toBe(true);
  });
});
