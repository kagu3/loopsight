import { describe, expect, test } from "vitest";
import { toModelJSON } from "simulation";
import {
  ModelStore,
  StoreError,
  buildModel,
  checkBrackets,
  emptyModel,
  importModelText,
  removeElements,
  setScenarios,
  setSimulation,
  similarNames,
  summarizeModel,
  upsertElements,
  validateModel,
  type ModelJSON,
} from "../src/core/index.js";
import { loadSample, sampleNames, sortedElements, tempDir } from "./helpers.js";

describe("ModelJSON の往復", () => {
  test.each(sampleNames())("%s: 保存 → 読み込み → エンジン → ModelJSON で一致する", async (name) => {
    const original = loadSample(name);
    const store = new ModelStore(await tempDir());
    await store.write(name, original);
    const loaded = await store.read(name);
    expect(loaded).toEqual(original);

    const back = toModelJSON(buildModel(loaded)) as unknown as ModelJSON;
    if (!original.engine) delete back.engine;
    if (!original.simulation) delete back.simulation;
    expect(sortedElements(back)).toEqual(sortedElements(original));
    expect({ ...back, elements: [] }).toEqual({ ...original, elements: [] });
  });

  test.each(sampleNames())("%s: 検証でエラーが出ない", (name) => {
    const result = validateModel(loadSample(name));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("作業フォルダ", () => {
  test("フォルダの外を指す名前を拒否する", async () => {
    const store = new ModelStore(await tempDir());
    for (const bad of ["../x", "a/b", "a\\b", "..", ".hidden", "", "c:x"]) {
      expect(() => store.pathOf(bad), bad).toThrow(StoreError);
    }
    expect(() => store.resolveInside("../outside.json")).toThrow(StoreError);
    expect(store.pathOf("人口モデル")).toMatch(/人口モデル\.json$/);
  });

  test("一覧にモデルが出る", async () => {
    const store = new ModelStore(await tempDir());
    await store.write("a", emptyModel("A"));
    await store.write("b", { ...emptyModel("B"), elements: [{ type: "VARIABLE", name: "x" }] });
    const list = await store.list();
    expect(list.map((m) => [m.name, m.title, m.elements])).toEqual([
      ["a", "A", 0],
      ["b", "B", 1],
    ]);
    await expect(store.read("zzz")).rejects.toThrow(/a, b/);
  });
});

describe("ModelJSON の取り込み", () => {
  test("ModelJSON を読み、名前がなければファイル名を使う", () => {
    const { model, warnings } = importModelText('﻿ {"elements":[{"type":"VARIABLE","name":"x","behavior":{"value":1}}]}', "inline");
    expect(warnings).toEqual([]);
    expect(model.name).toBe("inline");
    expect(validateModel(model).ok).toBe(true);
  });

  test("ModelJSON でなければわかるエラーにする", () => {
    expect(() => importModelText("hello")).toThrow(/ModelJSON/);
    expect(() => importModelText("<InsightMakerModel></InsightMakerModel>")).toThrow(/ModelJSON/);
    expect(() => importModelText('{"name":"x"}')).toThrow(/elements/);
  });
});

function sir(): ModelJSON {
  const m = emptyModel("sir", { time_length: 20 });
  upsertElements(m, [
    { type: "STOCK", name: "S", behavior: { initial_value: 990 } },
    { type: "STOCK", name: "I", behavior: { initial_value: 10 } },
    { type: "STOCK", name: "R", behavior: { initial_value: 0 } },
    { type: "VARIABLE", name: "Beta", behavior: { value: 0.3 } },
    { type: "VARIABLE", name: "Gamma", behavior: { value: 0.1 } },
    { type: "FLOW", name: "Infection", from: "S", to: "I", behavior: { value: "[Beta]*[S]*[I]/([S]+[I]+[R])" } },
    { type: "FLOW", name: "Recovery", from: "I", to: "R", behavior: { value: "[Gamma]*[I]" } },
  ]);
  return m;
}

describe("要素の編集", () => {
  test("追加すると足りないリンクを自動で足し、そのまま実行できる", () => {
    const m = emptyModel("t");
    const report = upsertElements(m, [
      { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
      { type: "STOCK", name: "Pop", behavior: { initial_value: 100 } },
      { type: "FLOW", name: "Growth", to: "Pop", behavior: { value: "[Pop]*[Rate]" } },
      { type: "VARIABLE", name: "Double", behavior: { value: "[Pop]*2" } },
    ]);
    expect(report.added).toHaveLength(4);
    // フローは自分のストックをリンクなしで参照できるので、足すのは Rate→Growth と Pop→Double だけ
    expect(report.auto_links.sort()).toEqual(["LINK Pop → Double", "LINK Rate → Growth"]);
    expect(validateModel(m)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test("autoLink を切るとリンク不足を検証で指摘する", () => {
    const m = emptyModel("t");
    upsertElements(m, [
      { type: "VARIABLE", name: "a", behavior: { value: 1 } },
      { type: "VARIABLE", name: "b", behavior: { value: "[a]+[nothing]" } },
    ], { autoLink: false });
    const r = validateModel(m);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/"a" から "b" へのリンクがありません/);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/\[nothing\]/);
  });

  test("既存の要素は名前で探して behavior を重ねる。null で項目を消す", () => {
    const m = sir();
    upsertElements(m, [{ name: "beta", behavior: { value: 0.5, units: "1/Weeks" } }]);
    upsertElements(m, [{ name: "Beta", behavior: { units: null } }]);
    expect(m.elements.find((e) => e.name === "Beta")!.behavior).toEqual({ value: 0.5 });
  });

  test("名前を変えると式とリンクの参照も変わる", () => {
    const m = sir();
    m.scenarios = [{ name: "high", values: { Beta: 0.5 } }];
    m.visualizations = [{ type: "TIME_SERIES", name: "v", elements: ["Beta", "S"] }];
    upsertElements(m, [{ name: "Beta", rename_to: "Contact Rate" }]);
    const inf = m.elements.find((e) => e.name === "Infection")!;
    expect(inf.behavior!.value).toBe("[Contact Rate]*[S]*[I]/([S]+[I]+[R])");
    expect(m.elements.some((e) => e.type === "LINK" && e.from === "Contact Rate" && e.to === "Infection")).toBe(true);
    expect(m.scenarios[0]!.values).toEqual({ "Contact Rate": 0.5 });
    expect(m.visualizations[0]!.elements).toEqual(["Contact Rate", "S"]);
    expect(validateModel(m).ok).toBe(true);
  });

  test("type なしで既存の名前に近い名前を指定すると、打ち間違いを指摘する", () => {
    const m = sir();
    expect(() => upsertElements(m, [{ name: "Bta", behavior: { value: 1 } }])).toThrow(/もしかして "Beta"/);
    expect(() => removeElements(m, [{ name: "Gama" }])).toThrow(/もしかして "Gamma"/);
  });

  test("種類の変更と、追加できない種類は断る", () => {
    const m = sir();
    expect(() => upsertElements(m, [{ type: "STOCK", name: "Beta" }])).toThrow(/種類/);
    expect(() => upsertElements(m, [{ type: "STATE", name: "On" }])).toThrow(/段階 1/);
    expect(() => upsertElements(m, [{ name: "New" }])).toThrow(/type が必要/);
  });

  test("ストックを消すとリンクは消え、フローの端は空になる", () => {
    const m = sir();
    const report = removeElements(m, [{ name: "R" }]);
    expect(report.removed).toEqual(['STOCK "R"', "LINK R → Infection"]);
    expect(m.elements.find((e) => e.name === "Recovery")!.to).toBeNull();
    // Infection の式はまだ [R] を参照している
    expect(report.notes.join("\n")).toMatch(/\[R\]/);
    expect(m.elements.some((e) => e.type === "LINK" && (e.from === "R" || e.to === "R"))).toBe(false);
  });

  test("cascadeFlows ならつながるフローとそのリンクも消す", () => {
    const m = sir();
    removeElements(m, [{ name: "I" }], { cascadeFlows: true });
    const names = m.elements.filter((e) => e.type !== "LINK").map((e) => e.name);
    expect(names.sort()).toEqual(["Beta", "Gamma", "R", "S"]);
    expect(m.elements.filter((e) => e.type === "LINK")).toEqual([]);
  });

  test("リンクは from と to で消せる", () => {
    const m = sir();
    removeElements(m, [{ from: "Gamma", to: "Recovery" }]);
    expect(validateModel(m).ok).toBe(false);
  });

  test("シミュレーション設定をおかしな値にはできない", () => {
    const m = sir();
    expect(setSimulation(m, { time_length: 50, time_units: "WEEKS" })).toMatchObject({ time_length: 50, time_units: "WEEKS", time_step: 1 });
    expect(() => setSimulation(m, { time_step: 0 })).toThrow();
    expect(() => setSimulation(m, { time_step: 100 })).toThrow();
  });

  test("名前を変えると、シナリオの値の式の中の参照も変わる", () => {
    const m = sir();
    m.scenarios = [{ name: "high", values: { Gamma: "[Beta]*2", S: 900 } }];
    upsertElements(m, [{ name: "Beta", rename_to: "Contact Rate" }]);
    expect(m.scenarios[0]!.values).toEqual({ Gamma: "[Contact Rate]*2", S: 900 });
  });

  test("消した要素の値はシナリオからも消える", () => {
    const m = sir();
    m.scenarios = [{ name: "high", values: { Beta: 0.5, Gamma: 0.2 } }];
    const report = removeElements(m, [{ name: "Gamma" }]);
    expect(m.scenarios[0]!.values).toEqual({ Beta: 0.5 });
    expect(report.notes).toContain('シナリオ "high" から "Gamma" の値を消しました。');
  });

  test("要約には式とつながりが入り、座標は入らない", () => {
    const s = summarizeModel(sir());
    expect(s.counts).toEqual({ STOCK: 3, VARIABLE: 2, FLOW: 2, LINK: 3 });
    expect(s.flows[0]).toMatchObject({ name: "Infection", from: "S", to: "I" });
    expect(s.title).toBe("sir");
    expect(s.links).toContain("Beta → Infection");
    expect(JSON.stringify(s)).not.toMatch(/coordinates/);
  });
});

describe("シナリオの保存", () => {
  test("追加し、名前で探して値を重ねる。値の名前は要素の表記にそろえる", () => {
    const m = sir();
    const r = setScenarios(m, [
      { name: "接触を減らす", description: "外出を控える", values: { beta: 0.2 } },
      { name: "早く治す", values: { Gamma: 0.2 } },
    ]);
    expect(r.added).toEqual(["接触を減らす", "早く治す"]);
    expect(m.scenarios).toEqual([
      { name: "接触を減らす", description: "外出を控える", values: { Beta: 0.2 } },
      { name: "早く治す", values: { Gamma: 0.2 } },
    ]);
    const r2 = setScenarios(m, [{ name: "早く治す", values: { Beta: 0.3, gamma: 0.25 } }, { name: "接触を減らす", description: null, values: { Beta: null } }]);
    expect(r2.updated).toEqual(["早く治す", "接触を減らす"]);
    expect(m.scenarios![1]!.values).toEqual({ Beta: 0.3, Gamma: 0.25 });
    expect(m.scenarios![0]).toEqual({ name: "接触を減らす", values: {} });
    expect(r2.notes.join("\n")).toMatch(/元のモデル/);
  });

  test("値を直しても、変える値の並び順は変えない。表記の違うキーは元の位置で要素の表記にそろえる", () => {
    const m = sir();
    m.scenarios = [{ name: "a", values: { beta: 0.2, Gamma: 0.2, S: 500 } }];
    setScenarios(m, [{ name: "a", values: { Gamma: 0.3 } }]);
    expect(Object.entries(m.scenarios[0]!.values)).toEqual([
      ["beta", 0.2],
      ["Gamma", 0.3],
      ["S", 500],
    ]);
    setScenarios(m, [{ name: "a", values: { Beta: 0.1 } }]);
    expect(Object.entries(m.scenarios![0]!.values)).toEqual([
      ["Beta", 0.1],
      ["Gamma", 0.3],
      ["S", 500],
    ]);
  });

  test("名前を変える、消す、すべて置き換える", () => {
    const m = sir();
    setScenarios(m, [{ name: "a", values: { Beta: 0.2 } }, { name: "b", values: { Beta: 0.3 } }]);
    const r = setScenarios(m, [{ name: "A", rename_to: "対策 A" }], { remove: ["b"] });
    expect(r.removed).toEqual(["b"]);
    expect(m.scenarios).toEqual([{ name: "対策 A", values: { Beta: 0.2 } }]);
    setScenarios(m, [{ name: "c", values: { S: 500 } }], { replace: true });
    expect(m.scenarios).toEqual([{ name: "c", values: { S: 500 } }]);
    setScenarios(m, [], { remove: ["c"] });
    expect(m.scenarios).toBeUndefined();
  });

  test("ない要素、値を変えられない要素、使えない名前はエラー", () => {
    const m = sir();
    expect(() => setScenarios(m, [{ name: "x", values: { Bta: 1 } }])).toThrow(/もしかして "Beta"/);
    m.elements.push({ type: "CONVERTER", name: "Table", behavior: { input: "TIME", data: [[0, 1]] } });
    expect(() => setScenarios(m, [{ name: "x", values: { Table: 1 } }])).toThrow(/CONVERTER/);
    expect(() => setScenarios(m, [{ name: "元のモデル", values: { Beta: 1 } }])).toThrow(/元のモデル/);
    setScenarios(m, [{ name: "x", values: { Beta: 1 } }, { name: "y", values: { Beta: 2 } }]);
    expect(() => setScenarios(m, [{ name: "y", rename_to: "X" }])).toThrow(/すでにあります/);
    expect(() => setScenarios(m, [{ name: "z", rename_to: "w" }])).toThrow(/見つかりません/);
    expect(() => setScenarios(m, [], { remove: ["nothing"] })).toThrow(/見つかりません/);
  });
});

describe("検証", () => {
  test("式の誤りは要素名と直し方つきで返す", () => {
    const m = emptyModel("t");
    upsertElements(m, [{ type: "VARIABLE", name: "y", behavior: { value: "3 +* 2" } }]);
    const r = validateModel(m);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ element: "y" });
    expect(r.errors[0]!.hint).toBeTruthy();
  });

  test("存在しない要素の参照には似た名前を示す", () => {
    const m = emptyModel("t");
    upsertElements(m, [
      { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
      { type: "VARIABLE", name: "y", behavior: { value: "[Birth Rat] * 2" } },
    ]);
    const r = validateModel(m);
    expect(r.errors[0]!.hint).toMatch(/もしかして "Birth Rate"/);
  });

  test("似た名前は近いものだけを返す", () => {
    expect(similarNames("Birth Rat", ["Birth Rate", "Death Rate", "Population"])).toEqual(["Birth Rate"]);
    expect(similarNames("mortality", ["Mortality"])).toEqual(["Mortality"]);
    expect(similarNames("xyz", ["Population"])).toEqual([]);
  });

  test("括弧の対応の誤りを、エンジンより先にわかる言葉で返す", () => {
    expect(checkBrackets("[A]*([B]")).toMatch(/\( を閉じる \) が 1 つ足りません/);
    expect(checkBrackets("[A])")).toMatch(/対応する開き括弧のない \)/);
    expect(checkBrackets("(1 + 2}")).toMatch(/\} で閉じています/);
    expect(checkBrackets("[Rate (per year)] * {1/(Prey * Years)}")).toBeUndefined();
    expect(checkBrackets('"(" + 1 // )')).toBeUndefined();
    expect(checkBrackets("1 + 2 # it's (note")).toBeUndefined();
    const m = emptyModel("t");
    upsertElements(m, [{ type: "VARIABLE", name: "y", behavior: { value: "2*(3" } }]);
    expect(validateModel(m).errors[0]!.message).toMatch(/足りません/);
  });

  test("エンジンの英語のメッセージは日本語にしてヒントを付ける", () => {
    const m = emptyModel("t");
    upsertElements(m, [{ type: "VARIABLE", name: "y", behavior: { value: "Foo(1)" } }]);
    const e = validateModel(m).errors[0]!;
    expect(e.message).toMatch(/変数か関数 "Foo" がありません/);
    expect(e.hint).toMatch(/関数名/);
    upsertElements(m, [{ name: "y", behavior: { value: "3 +* 2" } }]);
    expect(validateModel(m).errors[0]!.message).toMatch(/式の文法が正しくありません/);
  });

  test("式のない変数だけのモデル（因果ループ図）には警告を出す", () => {
    const r = validateModel(loadSample("cld"));
    expect(r.ok).toBe(true);
    expect(r.warnings[0]!.message).toMatch(/因果ループ図/);
    const m = emptyModel("t");
    upsertElements(m, [
      { type: "STOCK", name: "S", behavior: { initial_value: 1 } },
      { type: "VARIABLE", name: "k" },
    ]);
    expect(validateModel(m).warnings[0]!.message).toMatch(/式のない要素があります: k/);
  });

  test("ModelJSON の形の誤りはエンジンのメッセージをそのまま返す", () => {
    const m = { elements: [{ type: "STOCK", name: "s", behavior: { foo: 1 } }] } as unknown as ModelJSON;
    const r = validateModel(m);
    expect(r.errors[0]!.message).toMatch(/Invalid property "foo"/);
  });
});
