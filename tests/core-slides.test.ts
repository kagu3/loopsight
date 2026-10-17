import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  ImportError,
  MAX_LOOP_ELEMENTS,
  ModelStore,
  StoreError,
  checkModelName,
  checkSlides,
  emptyModel,
  namesByScenario,
  parseDataCSV,
  parseSlides,
  renameInSlides,
  scenarioRenamesSince,
  setScenarios,
  toSlideDeck,
  upsertElements,
  type SlideDeck,
} from "../src/core/index.js";
import { tempDir } from "./helpers.js";

function population() {
  const m = emptyModel("人口モデル", { time_length: 50 });
  upsertElements(m, [
    { type: "STOCK", name: "Population", behavior: { initial_value: 100 } },
    { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
    { type: "FLOW", name: "Births", to: "Population", behavior: { value: "[Population]*[Birth Rate]" } },
    // 原因のスライドのループ（Population → Births → Population）が R だと決まるように、極性を入れる
    { type: "LINK", from: "Population", to: "Births", behavior: { polarity: "POSITIVE" } },
  ]);
  setScenarios(m, [{ name: "支援", description: "出生率を下げる", values: { "Birth Rate": 0.02 } }]);
  return m;
}

/** 問題 → 原因 → 解決案 → 比較 → 結論 の筋書き */
function story(): SlideDeck {
  return toSlideDeck({
    title: "人口の見通し",
    slides: [
      { kind: "problem", title: "増えている", message: "このままだと増え続ける", elements: ["population"], data: ["POPULATION"], now: 30 },
      { kind: "cause", title: "原因", message: "増えるほど生まれる", loop: { elements: ["Population", "births"], polarity: "R" } },
      { kind: "solution", title: "支援", message: "支援する", scenario: "支援" },
      { kind: "compare", title: "比べる", message: "4 割減る", scenarios: ["元のモデル", "支援"], elements: ["Population"], at: 50 },
      { kind: "conclusion", title: "結論", message: "支援を進める" },
    ],
  });
}

const data = () => parseDataCSV("Year,Population\n0,100\n30,240\n");

describe("説明資料の筋書きを読む", () => {
  test("決まったキーだけの筋書きにする。知らないキーは捨てる", () => {
    const deck = toSlideDeck({ slides: [{ kind: "conclusion", title: "結論", message: "進める", extra: 1 }] });
    expect(deck).toEqual({ slides: [{ kind: "conclusion", title: "結論", message: "進める" }] });
    expect(parseSlides("﻿" + JSON.stringify(story()))).toEqual(story());
  });

  test("形が違えば、何枚目の何がおかしいかを添えて断る", () => {
    expect(() => parseSlides("{")).toThrow(ImportError);
    expect(() => toSlideDeck({})).toThrow(/slides/);
    expect(() => toSlideDeck({ slides: [{ kind: "chart", title: "a", message: "b" }] })).toThrow(/1 枚目.*"chart"/);
    expect(() => toSlideDeck({ slides: [{ kind: "conclusion", title: "a" }] })).toThrow(/message/);
    expect(() => toSlideDeck({ slides: [{ kind: "cause", title: "a", message: "b", loop: { elements: ["A"], polarity: "X" } }] })).toThrow(/"R" か "B"/);
    expect(() => toSlideDeck({ slides: [{ kind: "problem", title: "a", message: "b", elements: ["A"], now: "今" }] })).toThrow(/now は時刻/);
  });
});

describe("筋書きをモデルと照らし合わせる", () => {
  test("合う名前はモデルとデータの表記にそろえ、「元のモデル」は比べるシナリオから外す", () => {
    const deck = story();
    expect(checkSlides(population(), deck, data())).toEqual({ errors: [], warnings: [] });
    expect(deck.slides[0]).toMatchObject({ elements: ["Population"], data: ["Population"] });
    expect(deck.slides[1]).toMatchObject({ loop: { elements: ["Population", "Births"] } });
    expect(deck.slides[3]).toMatchObject({ scenarios: ["支援"] });
  });

  test("ない要素、シナリオ、データの列は、何枚目かと「もしかして」を添えて返す", () => {
    const deck = toSlideDeck({
      slides: [
        { kind: "problem", title: "a", message: "b", elements: ["Populaton"], data: ["Births"] },
        { kind: "cause", title: "a", message: "b", loop: { elements: ["Population"], polarity: "B" } },
        { kind: "solution", title: "a", message: "b", scenario: "支縁" },
        { kind: "compare", title: "a", message: "b", scenarios: ["元のモデル"], elements: ["Population"], at: 80 },
        { kind: "conclusion", title: "", message: "" },
      ],
    });
    const { errors, warnings } = checkSlides(population(), deck, data());
    const text = errors.map((e) => `${e.slide}: ${e.message} ${e.hint ?? ""}`).join("\n");
    expect(text).toMatch(/^1: 1 枚目（問題）: 注目する要素 "Populaton" がモデルにありません。 もしかして "Population"/m);
    expect(text).toMatch(/^1: .*実際のデータに列 "Births" がありません/m);
    expect(text).toMatch(/^2: .*ループを作る要素が 1 つだけ/m);
    expect(text).toMatch(/^3: .*シナリオ "支縁" がモデルにありません。 もしかして "支援"/m);
    expect(text).toMatch(/^4: .*比べるシナリオがありません/m);
    expect(text).toMatch(/^5: .*見出し/m);
    expect(warnings.map((w) => w.message).join("\n")).toMatch(/注目する時点（80）がシミュレーションの期間（0 から 50）の外/);
  });

  test("データの列を指定しているのに実際のデータがなければエラー。指定していなければ知らせるだけ", () => {
    const withColumn = checkSlides(population(), story());
    expect(withColumn.errors[0]!.message).toMatch(/実際のデータ.*がありません/);
    const deck = story();
    delete (deck.slides[0] as { data?: string[] }).data;
    const without = checkSlides(population(), deck);
    expect(without.errors).toEqual([]);
    expect(without.warnings[0]!.hint).toMatch(/import_data/);
  });
});

describe("原因のスライドのループをモデルで確かめる", () => {
  const cause = (elements: string[], polarity: "R" | "B") => toSlideDeck({ slides: [{ kind: "cause", title: "原因", message: "増えるほど生まれる", loop: { elements, polarity } }] });

  test("ループになっていなければエラー。find_loops で探すよう添える", () => {
    const m = population();
    upsertElements(m, [{ type: "VARIABLE", name: "Other", behavior: { value: 1 } }]);
    const { errors } = checkSlides(m, cause(["Population", "Other"], "R"));
    expect(errors[0]).toMatchObject({ slide: 1, message: expect.stringMatching(/ループになっていません。"Population" から "Other" へのつながり/), hint: expect.stringMatching(/find_loops/) });
  });

  test("空のときと、要素が多すぎるときは、そのことだけを知らせる", () => {
    expect(checkSlides(population(), cause([], "R")).errors.map((e) => e.message)).toEqual(["1 枚目（原因）: ループを作る要素がありません。"]);
    const many = Array.from({ length: MAX_LOOP_ELEMENTS + 1 }, () => "Population");
    const { errors } = checkSlides(population(), cause(many, "R"));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(`${MAX_LOOP_ELEMENTS} 個まで`);
    expect(errors[0]!.hint).toMatch(/短いループ.*find_loops/);
  });

  test("リンクの極性から決まる R / B と違えばエラー", () => {
    const { errors } = checkSlides(population(), cause(["Population", "Births"], "B"));
    expect(errors[0]!.message).toMatch(/polarity は B（釣り合わせるループ）ですが、リンクの極性から決めると R（強めるループ）です/);
    expect(errors[0]!.hint).toMatch(/behavior\.polarity/);
  });

  test("モデルで極性が決まっていなければ、スライドの R / B のまま出すと知らせる", () => {
    const m = population();
    m.elements.find((e) => e.type === "LINK" && e.from === "Population")!.behavior = {};
    const { errors, warnings } = checkSlides(m, cause(["Population", "Births"], "R"));
    expect(errors).toEqual([]);
    expect(warnings[0]!.message).toMatch(/極性が決まっていない/);
  });
});

describe("名前を変えたら筋書きの中も直す", () => {
  test("要素とシナリオの名前を変える（大文字と小文字は区別しない）", () => {
    const deck = story();
    checkSlides(population(), deck, data());
    expect(renameInSlides(deck, { elements: [["population", "人口"]], scenarios: [["支援", "家族計画の支援"]] })).toBe(true);
    expect(deck.slides[0]).toMatchObject({ elements: ["人口"], data: ["人口"] });
    expect(deck.slides[1]).toMatchObject({ loop: { elements: ["人口", "Births"] } });
    expect(deck.slides[2]).toMatchObject({ scenario: "家族計画の支援" });
    expect(deck.slides[3]).toMatchObject({ elements: ["人口"], scenarios: ["家族計画の支援"] });
    expect(renameInSlides(deck, { elements: [["Nope", "x"]] })).toBe(false);
  });

  test("シナリオの名前を変えたかを調べる", () => {
    const m = population();
    const before = namesByScenario(m);
    setScenarios(m, [{ name: "支援", rename_to: "家族計画の支援" }]);
    expect(scenarioRenamesSince(m, before)).toEqual([["支援", "家族計画の支援"]]);
  });

  test("ファイルの筋書きも直す。筋書きがなければ何もしない。読めなければ知らせる", async () => {
    const store = new ModelStore(await tempDir());
    expect(await store.renameSlideNames("pop", { elements: [["Population", "人口"]] })).toEqual({});
    const { file, version } = await store.writeSlides("pop", story());
    expect(file).toMatch(/pop\.slides\.json$/);
    const res = await store.renameSlideNames("pop", { elements: [["Population", "人口"]] });
    expect(res.note).toMatch(/pop\.slides\.json/);
    const after = await store.readSlidesText("pop");
    expect(after!.version).not.toBe(version);
    expect(parseSlides(after!.text).slides[0]).toMatchObject({ elements: ["人口"] });
    await writeFile(file, "{ 壊れた", "utf8");
    expect((await store.renameSlideNames("pop", { elements: [["人口", "Population"]] })).warning).toMatch(/直せませんでした/);
    expect(await readFile(file, "utf8")).toBe("{ 壊れた");
  });

  test("筋書きのファイルはモデルの一覧に出さず、.slides で終わるモデル名は断る", async () => {
    const store = new ModelStore(await tempDir());
    await store.write("pop", population());
    await store.writeSlides("pop", story());
    expect((await store.list()).map((m) => m.name)).toEqual(["pop"]);
    expect(() => checkModelName("pop.slides")).toThrow(StoreError);
    expect(() => checkModelName("pop.slides.json")).toThrow(/\.slides/);
  });
});
