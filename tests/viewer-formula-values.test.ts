import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runModel, type ModelJSON } from "../src/core/index.js";
import { peakIndex } from "../web/src/diagramValues.js";
import { formulaText, formulaView, tokenize, type FormulaToken } from "../web/src/formulaValues.js";
import { FIXTURES_DIR } from "./helpers.js";

const model = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "bullwhip.json"), "utf8")) as ModelJSON;
const data = runModel(model);
const series = Object.fromEntries([...data.columns].map(([k, vs]) => [k, vs.map((v) => (typeof v === "number" ? v : null))]));

/** 下の行（値を入れた式）を計算する。Max / Min だけを JavaScript の関数に置き換える */
function evaluate(tokens: FormulaToken[]): number {
  const js = tokens
    .map((t) => {
      if (t.kind === "ref") {
        if (t.raw === undefined) throw new Error(`値のない参照：${t.text}`);
        return `(${t.raw})`;
      }
      if (t.kind === "func") return { max: "Math.max", min: "Math.min" }[t.text.toLowerCase()] ?? t.text;
      return { "×": "*", "÷": "/", "−": "-" }[t.text] ?? t.text;
    })
    .join(" ");
  return new Function(`return ${js};`)() as number;
}

describe("tokenize（式を片に分ける）", () => {
  test("参照・数・単位つきの数・関数・演算子・括弧に分ける。演算子は算数の記号にする", () => {
    const { tokens, multiline } = tokenize("Max(0, [A] * {2 Meters} - [B b] / 3.5e2)");
    expect(tokens.map((t) => `${t.kind}:${t.text}`)).toEqual([
      "func:Max",
      "paren:(",
      "num:0",
      "comma:,",
      "ref:A",
      "op:×",
      "num:{2 Meters}",
      "op:−",
      "ref:B b",
      "op:÷",
      "num:3.5e2",
      "paren:)",
    ]);
    expect(multiline).toBe(false);
  });
  test("複数の行やコメントがあれば、そろえられない式とする。コメントは飛ばし、後ろの参照は拾う", () => {
    expect(tokenize("x <- [A]\nx * 2").multiline).toBe(true);
    expect(tokenize("[A] # コメント").multiline).toBe(true);
    const block = tokenize("/* c */ [A] + 1");
    expect(block.multiline).toBe(true);
    expect(block.tokens.map((t) => `${t.kind}:${t.text}`)).toEqual(["ref:A", "op:+", "num:1"]);
    expect(tokenize("[A] // c\n+ [B]").tokens.map((t) => t.text)).toEqual(["A", "+", "B"]);
  });
  test("代入の <- は 1 つの演算子（← で出す）", () => {
    expect(tokenize("x <- [A]").tokens.map((t) => `${t.kind}:${t.text}`)).toEqual(["other:x", "op:←", "ref:A"]);
  });
});

describe("formulaView（ブルウィップのモデル）", () => {
  test.each(["小売の発注", "卸の発注", "工場の生産指示"])("「%s」の値を入れた計算の結果が、左辺の値と合う（最大の振れの時点とほかの時点）", (name) => {
    const at = peakIndex(series[name]!)!;
    for (const i of [at, 0, 15, 30, data.times.length - 1]) {
      const v = formulaView(model, name, series, i)!;
      expect(v.layout).toBe("aligned");
      expect(v.tokens.filter((t) => t.kind === "ref").every((t) => t.value !== undefined && !t.held)).toBe(true);
      expect(evaluate(v.tokens)).toBeCloseTo(v.raw!, 6);
    }
  });

  test("上の行は括弧を外した式、下の行は同じ並びで値を入れたもの", () => {
    const v = formulaView(model, "小売の発注", series, 25)!;
    expect(v.name).toBe("小売の発注");
    expect(formulaText(v.tokens)).toBe("Max(0, 小売の需要予測 + (小売の目標在庫 − 小売の在庫) ÷ 在庫の調整時間)");
    expect(v.tokens.find((t) => t.text === "在庫の調整時間")?.value).toBe("2");
    expect(v.refs.map((r) => r.name)).toEqual(["小売の需要予測", "小売の目標在庫", "小売の在庫", "在庫の調整時間"]);
  });

  test("シナリオの実行結果を渡せば、その値を入れる", () => {
    const slow = runModel(model, { overrides: { 在庫の調整時間: 8 } });
    const s2 = Object.fromEntries([...slow.columns].map(([k, vs]) => [k, vs.map((v) => (typeof v === "number" ? v : null))]));
    const v = formulaView(model, "小売の発注", s2, 25)!;
    expect(v.tokens.find((t) => t.text === "在庫の調整時間")?.value).toBe("8");
    expect(evaluate(v.tokens)).toBeCloseTo(v.raw!, 6);
  });

  test("ストックは、入る量 − 出る量。左辺は次の時点までの増え方と合う", () => {
    for (const i of [5, 22, 40]) {
      const v = formulaView(model, "小売の在庫", series, i)!;
      expect(v.name).toBe("小売の在庫の増え方");
      expect(formulaText(v.tokens)).toBe("卸から小売への出荷 − 販売");
      expect(evaluate(v.tokens)).toBeCloseTo(v.raw!, 9);
      const stock = series["小売の在庫"]!;
      expect(v.raw!).toBeCloseTo(stock[i + 1]! - stock[i]!, 6);
    }
    // 入ってくるだけのフロー（雲から）も入る量に数える
    expect(formulaText(formulaView(model, "工場の在庫", series, 10)!.tokens)).toBe("生産 − 工場から卸への出荷");
  });

  test("時間をまたぐ関数に渡す値は名前のまま、ほかの参照には値を入れる。関数はそのまま出す", () => {
    const v = formulaView(model, "卸から小売への出荷", series, 20)!;
    expect(formulaText(v.tokens)).toBe("Min(Delay(小売の発注, 出荷の遅れ, 100), 卸の在庫)");
    const ref = (n: string) => v.tokens.find((t) => t.text === n)!;
    expect(ref("小売の発注")).toEqual({ kind: "ref", text: "小売の発注", held: true });
    expect(ref("出荷の遅れ").value).toBe("2");
    expect(ref("卸の在庫").value).toBeDefined();
    expect(v.refs.find((r) => r.name === "小売の発注")).toMatchObject({ held: true, value: "（過去の値を使います）" });
    // Smooth の 2 つ目の引数（期間）には値を入れる
    const s = formulaView(model, "小売の需要予測", series, 20)!;
    expect(s.tokens.find((t) => t.text === "消費者の需要")?.held).toBe(true);
    expect(s.tokens.find((t) => t.text === "予測の期間")?.value).toBe("4");
  });

  test("後ろに書く時間をまたぐ関数（[A].PastMax()）に渡す参照にも、値を入れない", () => {
    const m: ModelJSON = {
      elements: [
        { type: "VARIABLE", name: "A", behavior: { value: 1 } },
        { type: "VARIABLE", name: "B", behavior: { value: "[A].PastMax() + [A].Abs()" } },
      ],
    };
    const v = formulaView(m, "B", { A: [3], B: [6] }, 0)!;
    expect(formulaText(v.tokens)).toBe("A.PastMax() + A.Abs()");
    expect(v.tokens.filter((t) => t.kind === "ref").map((t) => t.held ?? false)).toEqual([true, false]);
    expect(v.refs).toEqual([{ name: "A", value: "3" }]);
  });

  test("決まった値の変数は式を出さず、値だけ。参照のない式は出す。ない要素は出さない", () => {
    expect(formulaView(model, "在庫の調整時間", series, 3)).toMatchObject({ name: "在庫の調整時間", value: "2", tokens: [] });
    expect(formulaView(model, "ない要素", series, 3)).toBeUndefined();
    // 参照がなくても、関数を含む式は出す
    const demand = formulaView(model, "消費者の需要", series, 30)!;
    expect(formulaText(demand.tokens)).toBe("100 + Step(5, 20)");
    expect(demand.value).toBe("120");
  });

  test("長い式や、複数の行の式は、参照ごとの値の一覧にする", () => {
    const long: ModelJSON = {
      elements: [
        { type: "VARIABLE", name: "A", behavior: { value: 1 } },
        { type: "VARIABLE", name: "B", behavior: { value: Array.from({ length: 13 }, () => "[A]").join(" + ") } },
        { type: "VARIABLE", name: "C", behavior: { value: "x <- [A]\nIfThenElse(x > 0, x, 0)" } },
      ],
    };
    const s = { A: [1], B: [13], C: [1] };
    expect(formulaView(long, "B", s, 0)).toMatchObject({ layout: "list", refs: [{ name: "A", value: "1" }] });
    expect(formulaView(long, "C", s, 0)!.layout).toBe("list");
  });

  test("片の数が少なくても、名前が長くて箱の幅に収まらない式は一覧にする", () => {
    const names = Array.from({ length: 8 }, (_, i) => `とても長い名前の参照その${i + 1}`);
    const wide: ModelJSON = {
      elements: [
        ...names.map((n) => ({ type: "VARIABLE" as const, name: n, behavior: { value: 1 } })),
        { type: "VARIABLE", name: "合計", behavior: { value: names.map((n) => `[${n}]`).join(" + ") } },
      ],
    };
    const s = Object.fromEntries([...names, "合計"].map((n) => [n, [1]]));
    const v = formulaView(wide, "合計", s, 0)!;
    expect(v.tokens.length).toBeLessThan(24);
    expect(v.layout).toBe("list");
    // ブルウィップの式は収まる
    expect(formulaView(model, "工場の生産指示", series, 10)!.layout).toBe("aligned");
  });
});
