import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { describeLoop, emptyModel, findLoops, upsertElements, type ModelJSON } from "../src/core/index.js";
import { FIXTURES_DIR } from "./helpers.js";

/** ブルックスの法則のモデル（遅れているプロジェクトに人を足すと、さらに遅れる）。リンクに極性はない */
function brooksLaw(): ModelJSON {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, "brooks_law.json"), "utf8")) as ModelJSON;
}

/** 下げる向きに効くリンク。ほかのリンクは POSITIVE にする */
const NEGATIVE = [
  ["意思疎通に取られる割合", "実際に働ける人数"],
  ["教育に取られる時間", "実際に働ける人数"],
  ["全員の人数", "採用"],
  ["締め切り", "管理者が考える必要な人数"],
  ["標準の生産性", "管理者が考える必要な人数"],
  ["採用の時間", "採用"],
  ["慣れるまでの時間", "慣れる"],
];

function withPolarity(m: ModelJSON): ModelJSON {
  for (const el of m.elements) {
    if (el.type !== "LINK") continue;
    const negative = NEGATIVE.some(([from, to]) => el.from === from && el.to === to);
    el.behavior = { ...el.behavior, polarity: negative ? "NEGATIVE" : "POSITIVE" };
  }
  return m;
}

/** n 個の変数が、自分以外のすべてを参照しあうモデル（ループが非常に多い） */
function complete(n: number): ModelJSON {
  const m = emptyModel("complete");
  const names = Array.from({ length: n }, (_, i) => `N${i}`);
  upsertElements(
    m,
    names.map((name) => ({ type: "VARIABLE" as const, name, behavior: { value: names.filter((o) => o !== name).map((o) => `[${o}]`).join(" + ") } })),
  );
  return m;
}

// brooks_law の主なループ
/** 人を足して遅れを取り戻す */
const CATCH_UP = ["残りの作業", "管理者が考える必要な人数", "採用", "新人", "実際に働ける人数", "作業の進み"];
/** 人が増えると意思疎通の手間が増え、かえって作業が残り、さらに人を足す（ブルックスの法則） */
const COMMUNICATION = ["残りの作業", "管理者が考える必要な人数", "採用", "新人", "全員の人数", "意思疎通の経路の数", "意思疎通に取られる割合", "実際に働ける人数", "作業の進み"];
/** 足りない人数を埋めたら採用をやめる */
const HIRING = ["新人", "全員の人数", "採用"];

describe("ループを探す", () => {
  test("brooks_law の主なループを返す（極性がなければ、決まっていないことを返す）", () => {
    const { loops, truncated } = findLoops(brooksLaw());
    expect(truncated).toBe(false);
    const elements = loops.map((l) => l.elements);
    expect(elements).toContainEqual(CATCH_UP);
    expect(elements).toContainEqual(COMMUNICATION);
    expect(elements).toContainEqual(HIRING);
    // 極性のないリンクがあるので、どれも R か B か決まらない
    expect(loops.every((l) => l.kind === "unknown")).toBe(true);
    expect(loops.map((l) => l.name).slice(0, 2)).toEqual(["?1", "?2"]);
    const hiring = loops.find((l) => l.elements.join() === HIRING.join())!;
    expect(hiring.steps).toEqual([
      { from: "新人", to: "全員の人数", polarity: "?", via: "link" },
      { from: "全員の人数", to: "採用", polarity: "?", via: "link" },
      { from: "採用", to: "新人", polarity: "+", via: "flow" },
    ]);
  });

  test("brooks_law にリンクの極性を入れると、R と B が決まる", () => {
    const { loops } = findLoops(withPolarity(brooksLaw()));
    const kind = (els: string[]) => loops.find((l) => l.elements.join() === els.join())?.kind;
    expect(kind(CATCH_UP)).toBe("B");
    expect(kind(COMMUNICATION)).toBe("R");
    expect(kind(HIRING)).toBe("B");
    // 名前は種類ごとの通し番号
    expect(loops.find((l) => l.kind === "B")!.name).toBe("B1");
    expect(loops.find((l) => l.kind === "R")!.name).toBe("R1");
    // 新人 → 慣れる はリンクがなく、慣れるの式が自分の出元のストックを見ているだけなので決まらない
    const maturing = loops.find((l) => l.elements.join() === "新人,慣れる")!;
    expect(maturing.kind).toBe("unknown");
    expect(maturing.steps[0]).toEqual({ from: "新人", to: "慣れる", polarity: "?", via: "reference" });
    // 短い順
    const lengths = loops.map((l) => l.elements.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });

  test("フローは行き先を増やし、出元を減らす", () => {
    const m = emptyModel("population");
    upsertElements(m, [
      { type: "STOCK", name: "Population", behavior: { initial_value: 100 } },
      { type: "VARIABLE", name: "Births Per Year", behavior: { value: "[Population] * 0.03" } },
      { type: "VARIABLE", name: "Deaths Per Year", behavior: { value: "[Population] * 0.01" } },
      { type: "FLOW", name: "Births", from: null, to: "Population", behavior: { value: "[Births Per Year]" } },
      { type: "FLOW", name: "Deaths", from: "Population", to: null, behavior: { value: "[Deaths Per Year]" } },
      { from: "Population", to: "Births Per Year", behavior: { polarity: "POSITIVE" } },
      { from: "Births Per Year", to: "Births", behavior: { polarity: "POSITIVE" } },
      { from: "Population", to: "Deaths Per Year", behavior: { polarity: "POSITIVE" } },
      { from: "Deaths Per Year", to: "Deaths", behavior: { polarity: "POSITIVE" } },
    ]);
    const { loops } = findLoops(m);
    expect(loops.map((l) => [l.name, l.kind, l.elements])).toEqual([
      ["R1", "R", ["Population", "Births Per Year", "Births"]],
      ["B1", "B", ["Population", "Deaths Per Year", "Deaths"]],
    ]);
  });

  test("要素を通るループだけ、決めた長さまでのループだけに絞れる", () => {
    const m = brooksLaw();
    const through = findLoops(m, { element: "意思疎通の経路の数" }).loops;
    expect(through.length).toBeGreaterThan(0);
    expect(through.every((l) => l.elements.includes("意思疎通の経路の数"))).toBe(true);
    expect(findLoops(m, { maxLength: 3 }).loops.map((l) => l.elements.length)).toEqual([2, 3]);
  });

  test("数が上限を超えたら、そこで探すのをやめて知らせる。短いループから探すので、短いものは抜けない", () => {
    const all = findLoops(brooksLaw()).loops;
    const r = findLoops(brooksLaw(), { maxLoops: 3 });
    expect(r.truncated).toBe("loops");
    expect(r.loops.map((l) => l.elements)).toEqual(all.slice(0, 3).map((l) => l.elements));
  });

  test("ループの多いモデルでも、element を通るループは上限に押し出されずに見つかる", () => {
    // 8 要素がすべて互いに参照しあう（ループが非常に多い）ところと、別の X ⇄ Y のループ
    const m = complete(8);
    upsertElements(m, [
      { type: "VARIABLE", name: "X", behavior: { value: "[Y]" } },
      { type: "VARIABLE", name: "Y", behavior: { value: "[X]" } },
    ]);
    const all = findLoops(m);
    expect(all.truncated).toBe("loops");
    expect(findLoops(m, { element: "x" })).toMatchObject({ truncated: false, loops: [{ elements: ["X", "Y"] }] });
  });

  test("たどった手数が上限を超えたら、そこで探すのをやめて知らせる", () => {
    const r = findLoops(complete(8), { maxLoops: Infinity, maxSteps: 1000 });
    expect(r.truncated).toBe("steps");
    expect(r.loops.length).toBeGreaterThan(0);
  });

  test("ループのない、つながりの多いモデルはすぐに終わる", () => {
    // 前の要素をすべて参照する 40 要素（循環はない）
    const m = emptyModel("dense");
    upsertElements(
      m,
      Array.from({ length: 40 }, (_, i) => ({
        type: "VARIABLE" as const,
        name: `V${i}`,
        behavior: { value: i ? Array.from({ length: i }, (_, j) => `[V${j}]`).join(" + ") : 1 },
      })),
    );
    const start = performance.now();
    expect(findLoops(m)).toEqual({ loops: [], truncated: false });
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("循環のないモデルでは何も返さない", () => {
    const m = emptyModel("bathtub");
    upsertElements(m, [
      { type: "STOCK", name: "Water", behavior: { initial_value: 10 } },
      { type: "FLOW", name: "Drain", from: "Water", to: null, behavior: { value: 1 } },
    ]);
    expect(findLoops(m)).toEqual({ loops: [], truncated: false });
  });
});

describe("要素名の並びのループ", () => {
  test("つながりと R / B を返す。名前はモデルの表記にそろえる", () => {
    const m = withPolarity(brooksLaw());
    const r = describeLoop(m, HIRING);
    expect(r).toMatchObject({ loop: { kind: "B", elements: HIRING } });
    if (!("loop" in r)) throw new Error("ループのはず");
    expect(r.loop.steps.map((s) => s.polarity)).toEqual(["+", "-", "+"]);
    // 大文字小文字の違う表記は、モデルの表記にそろえる
    upsertElements(m, [
      { type: "VARIABLE", name: "A", behavior: { value: "[B]" } },
      { type: "VARIABLE", name: "B", behavior: { value: "[A]" } },
    ]);
    expect(describeLoop(m, ["a", "b"])).toMatchObject({ loop: { kind: "unknown", elements: ["A", "B"] } });
  });

  test("つながっていなければ、どこがつながっていないかを返す", () => {
    expect(describeLoop(brooksLaw(), ["新人", "採用"])).toEqual({ error: '"新人" から "採用" へのつながり（リンクかフロー）がありません。' });
    expect(describeLoop(brooksLaw(), ["新人", "だれか"])).toEqual({ error: '要素が見つかりません: "だれか"' });
  });

  test("同じ要素が 2 度出てくる並びは受け付けない（2 周すると B のループが R に見えてしまう）", () => {
    const m = withPolarity(brooksLaw());
    const r = describeLoop(m, [...HIRING, ...HIRING]);
    expect("error" in r && r.error).toMatch(/同じ要素が 2 度/);
  });
});
