import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { toModelJSON } from "simulation";
import {
  ModelStore,
  StoreError,
  buildModel,
  checkBrackets,
  emptyModel,
  importInsightMakerXML,
  importModelText,
  removeElements,
  setSimulation,
  similarNames,
  summarizeModel,
  upsertElements,
  validateModel,
  type ModelJSON,
} from "../src/core/index.js";
import { FIXTURES_DIR, loadSample, sampleNames, sortedElements, tempDir } from "./helpers.js";

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

describe(".InsightMaker の取り込み", () => {
  test("座標を保ったまま ModelJSON にできて、実行結果も同じ", async () => {
    const xml = await readFile(path.join(FIXTURES_DIR, "population.InsightMaker"), "utf8");
    const { model, warnings } = importModelText(xml, "population");
    expect(warnings).toEqual([]);
    expect(model.name).toBe("population");

    const stock = model.elements.find((e) => e.name === "Population")!;
    expect(stock.display?.coordinates).toEqual([300, 150]);
    expect(stock.display?.size).toEqual([100, 40]);
    const births = model.elements.find((e) => e.name === "Births")!;
    expect(births.display?.from_coordinates).toEqual([350, 40]);
    expect(model.elements.filter((e) => e.type === "LINK")).toHaveLength(2);

    expect(validateModel(model).ok).toBe(true);
    const m = buildModel(model);
    const pop = m.find((p) => p.name === "Population")[0]!;
    expect(m.simulate().value(pop)).toBeCloseTo(100 * 1.05 ** 50, 6);
  });

  test("フォルダの中の要素はフォルダの位置を足す", () => {
    const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <Setting TimeLength="10" TimeStart="0" TimeStep="1" TimeUnits="Years" SolutionAlgorithm="RK1" id="2"><mxCell parent="1" vertex="1" visible="0"><mxGeometry x="20" y="20" width="80" height="40" as="geometry"/></mxCell></Setting>
      <Folder name="Group &amp; Co" Type="None" id="3"><mxCell style="folder" parent="1" vertex="1"><mxGeometry x="100" y="200" width="300" height="200" as="geometry"/></mxCell></Folder>
      <Variable name="A &amp; B" Equation="1" Units="Unitless" id="4"><mxCell style="variable" parent="3" vertex="1"><mxGeometry x="10" y="20" width="120" height="50" as="geometry"/></mxCell></Variable>
      </root></mxGraphModel>`;
    const { model, warnings } = importInsightMakerXML(xml);
    const v = model.elements.find((e) => e.name === "A & B")!;
    expect(v.display?.coordinates).toEqual([110, 220]);
    expect(warnings.join()).toMatch(/Folder/);
  });

  test("Insight Maker の XML でなければわかるエラーにする", () => {
    expect(() => importModelText("hello")).toThrow(/ModelJSON/);
    expect(() => importModelText("<html></html>")).toThrow(/Insight Maker/);
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

  test("要約には式とつながりが入り、座標は入らない", () => {
    const s = summarizeModel(sir());
    expect(s.counts).toEqual({ STOCK: 3, VARIABLE: 2, FLOW: 2, LINK: 3 });
    expect(s.flows[0]).toMatchObject({ name: "Infection", from: "S", to: "I" });
    expect(s.title).toBe("sir");
    expect(s.links).toContain("Beta → Infection");
    expect(JSON.stringify(s)).not.toMatch(/coordinates/);
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
