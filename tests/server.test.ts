import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../src/mcp/server.js";
import { boxLayout, validateModel, type ModelJSON } from "../src/core/index.js";
import { FIXTURES_DIR, SAMPLES_DIR, tempDir } from "./helpers.js";

let client: Client;
let dir: string;

beforeEach(async () => {
  dir = await tempDir();
  const server = createServer({ modelsDir: dir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
});

/** ツールを呼んで JSON の結果を返す。エラーなら例外にする */
async function call<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await client.callTool({ name, arguments: args });
  expect(res.isError).toBe(true);
  return (res.content as { text: string }[])[0]!.text;
}

const SIR = [
  { type: "STOCK", name: "Susceptible", behavior: { initial_value: 990 } },
  { type: "STOCK", name: "Infected", behavior: { initial_value: 10 } },
  { type: "STOCK", name: "Recovered", behavior: { initial_value: 0 } },
  { type: "VARIABLE", name: "Contact Rate", behavior: { value: 0.4 } },
  { type: "VARIABLE", name: "Recovery Rate", behavior: { value: 0.1 } },
  { type: "VARIABLE", name: "Total", behavior: { value: "[Susceptible]+[Infected]+[Recovered]" } },
  { type: "FLOW", name: "Infection", from: "Susceptible", to: "Infected", behavior: { value: "[Contact Rate]*[Susceptible]*[Infected]/[Total]" } },
  { type: "FLOW", name: "Recovery", from: "Infected", to: "Recovered", behavior: { value: "[Recovery Rate]*[Infected]" } },
];

describe("MCP server", () => {
  test("クライアントから接続でき、19 個のツールが見える", async () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toMatch(/ModelJSON/);
    expect(client.getInstructions()).toMatch(/「会議資料を作って」[^]*問題 → 原因 → 解決案 → 比較 → 結論/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_model",
        "export_model",
        "export_slides",
        "find_loops",
        "get_model",
        "import_data",
        "import_model",
        "layout_model",
        "list_models",
        "remove_elements",
        "run_simulation",
        "set_scenarios",
        "set_simulation",
        "set_slides",
        "sweep_parameter",
        "upsert_elements",
        "validate_model",
        "view_diagram",
        "view_slides",
      ].sort(),
    );
  });

  test("作る → 要素を足す → 実行 → 振る → 書き出す", async () => {
    await call("create_model", { model: "sir", title: "SIR", simulation: { time_length: 100, time_units: "DAYS" } });
    expect(await callError("create_model", { model: "sir" })).toMatch(/overwrite/);

    const up = await call("upsert_elements", { model: "sir", elements: SIR });
    expect(up.changes.added).toHaveLength(8);
    expect(up.changes.auto_links.length).toBeGreaterThan(0);
    expect(up.validation).toMatchObject({ ok: true, errors: [] });

    const list = await call("list_models");
    expect(list.models).toMatchObject([{ name: "sir", title: "SIR" }]);

    const summary = await call("get_model", { model: "sir" });
    expect(summary.stocks).toHaveLength(3);
    expect(summary.flows[0]).toMatchObject({ name: "Infection", from: "Susceptible", to: "Infected" });

    const run = await call("run_simulation", { model: "sir", samples: 5, csv: true });
    expect(run.steps).toBe(101);
    expect(Object.keys(run.results)).toEqual(["Susceptible", "Infected", "Recovered"]);
    expect(run.results.Infected.max).toBeGreaterThan(100);
    expect(run.results.Infected.series).toHaveLength(5);
    const csv = await readFile(run.csv, "utf8");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\n")[0]).toContain("Infected");
    expect(path.relative(dir, run.csv)).toMatch(/^output/);

    // 一時的な上書きはファイルを変えない
    const low = await call("run_simulation", { model: "sir", overrides: { "contact rate": 0.05 }, samples: 0 });
    expect(low.results.Infected.max).toBeLessThan(run.results.Infected.max);
    const full = await call<ModelJSON>("get_model", { model: "sir", format: "full" });
    expect(full.elements.find((e) => e.name === "Contact Rate")!.behavior!.value).toBe(0.4);

    const sweep = await call("sweep_parameter", { model: "sir", parameter: "Contact Rate", from: 0.1, to: 0.5, steps: 3, elements: ["Infected"] });
    expect(sweep.rows.map((r: any) => r.scenario)).toEqual(["Contact Rate = 0.1", "Contact Rate = 0.3", "Contact Rate = 0.5"]);
    const peaks = sweep.rows.map((r: any) => r.results.Infected.max);
    expect(peaks[0]).toBeLessThan(peaks[1]);
    expect(peaks[1]).toBeLessThan(peaks[2]);

    const scen = await call("sweep_parameter", {
      model: "sir",
      scenarios: [
        { name: "対策なし", overrides: {} },
        { name: "対策あり", overrides: { "Contact Rate": 0.2, "Recovery Rate": 0.15 } },
      ],
      elements: ["Infected", "Recovered"],
    });
    expect(scen.rows).toHaveLength(2);

    const exp = await call("export_model", { model: "sir" });
    expect(path.relative(dir, exp.file)).toBe(path.join("exports", "sir.json"));
    expect(exp.placed_elements).toHaveLength(6);
    const exported = JSON.parse(await readFile(exp.file, "utf8")) as ModelJSON;
    expect(validateModel(exported).ok).toBe(true);
    for (const el of exported.elements.filter((e) => e.type === "STOCK" || e.type === "VARIABLE")) {
      expect(el.display?.coordinates, el.name).toBeDefined();
      // 箱の大きさは図と同じ（名前の長さから決めたもの）
      expect(el.display?.size, el.name).toEqual(boxLayout(el.type, el.name!).size);
    }
    // グラフの設定がないので、ストックの時系列グラフが足される
    expect(exp.added_chart).toMatchObject({ type: "TIME_SERIES", elements: ["Susceptible", "Infected", "Recovered"] });
    expect(exported.visualizations).toEqual([exp.added_chart]);
    // save_layout を付けなければモデル本体には座標を書かない。グラフも書かない
    const after = await call<ModelJSON>("get_model", { model: "sir", format: "full" });
    expect(after.elements.some((e) => e.display?.coordinates)).toBe(false);
    expect(after.elements.some((e) => e.display?.size)).toBe(false);
    expect(after.visualizations).toBeUndefined();
    const noChart = await call("export_model", { model: "sir", path: "exports/no-chart.json", chart: false });
    expect(noChart.added_chart).toBeUndefined();
    expect((JSON.parse(await readFile(noChart.file, "utf8")) as ModelJSON).visualizations).toBeUndefined();
  });

  test("名前を変えて、消して、設定を変える", async () => {
    await call("create_model", { model: "m" });
    await call("upsert_elements", { model: "m", elements: SIR });
    const renamed = await call("upsert_elements", { model: "m", elements: [{ name: "Total", rename_to: "Population" }] });
    expect(renamed.validation.ok).toBe(true);

    const removed = await call("remove_elements", { model: "m", elements: [{ name: "Recovered" }] });
    expect(removed.changes.notes.join("\n")).toMatch(/\[Recovered\]/);
    expect(removed.validation.ok).toBe(false);
    expect(removed.validation.errors[0].hint).toBeTruthy();

    const fixed = await call("upsert_elements", { model: "m", elements: [{ name: "Population", behavior: { value: "[Susceptible]+[Infected]" } }] });
    expect(fixed.validation.ok).toBe(true);

    const sim = await call("set_simulation", { model: "m", time_step: 0.25, algorithm: "RK4" });
    expect(sim.simulation).toMatchObject({ time_step: 0.25, algorithm: "RK4", time_length: 100 });
    expect(await callError("set_simulation", { model: "m", time_step: -1 })).toMatch(/time_step/);
  });

  test("シナリオを保存し、「元のモデル」と比べる。要素の名前を変えるとシナリオの中も変わる", async () => {
    await call("create_model", { model: "s" });
    await call("upsert_elements", { model: "s", elements: SIR });
    const saved = await call("set_scenarios", {
      model: "s",
      scenarios: [
        { name: "外出を控える", description: "接触を半分にする", values: { "contact rate": 0.2 } },
        { name: "早く治す", values: { "Recovery Rate": 0.2 } },
      ],
      elements: ["Infected"],
    });
    expect(saved.changes.added).toEqual(["外出を控える", "早く治す"]);
    expect(saved.validation.ok).toBe(true);
    expect(saved.comparison.rows.map((r: any) => r.scenario)).toEqual(["元のモデル", "外出を控える", "早く治す"]);
    const peaks = saved.comparison.rows.map((r: any) => r.results.Infected.max);
    expect(peaks[1]).toBeLessThan(peaks[0]);
    expect(peaks[2]).toBeLessThan(peaks[0]);

    // 保存したシナリオは sweep_parameter でも「元のモデル」と並べて比べられる
    const sweep = await call("sweep_parameter", { model: "s", overrides: { "Recovery Rate": 0.3 }, elements: ["Infected"] });
    expect(sweep.rows.map((r: any) => r.scenario)).toEqual(["元のモデル", "外出を控える", "早く治す"]);
    // 「元のモデル」には overrides を当てない
    expect(sweep.rows[0].overrides).toEqual({});
    expect(sweep.rows[0].results.Infected.max).toBe(peaks[0]);
    expect(sweep.rows[1].overrides).toEqual({ "Contact Rate": 0.2, "Recovery Rate": 0.3 });

    await call("upsert_elements", { model: "s", elements: [{ name: "Contact Rate", rename_to: "接触率" }] });
    const renamed = await call("set_scenarios", { model: "s", scenarios: [{ name: "早く治す", rename_to: "治療を早める" }] });
    expect(renamed.scenarios).toEqual([
      { name: "外出を控える", description: "接触を半分にする", values: { 接触率: 0.2 } },
      { name: "治療を早める", values: { "Recovery Rate": 0.2 } },
    ]);

    // 実行できないシナリオは保存しない
    expect(await callError("set_scenarios", { model: "s", scenarios: [{ name: "壊れた", values: { 接触率: "[Nope]" } }] })).toMatch(/壊れた/);
    expect(await callError("set_scenarios", { model: "s", scenarios: [{ name: "x", values: { Contact: 1 } }] })).toMatch(/見つかりません/);
    expect(await callError("set_scenarios", { model: "s" })).toMatch(/scenarios か remove/);
    const full = await call<ModelJSON>("get_model", { model: "s", format: "full" });
    expect(full.scenarios!.map((s) => s.name)).toEqual(["外出を控える", "治療を早める"]);

    const removed = await call("set_scenarios", { model: "s", remove: ["外出を控える", "治療を早める"] });
    expect(removed.scenarios).toEqual([]);
    expect(removed.comparison).toBeUndefined();
  });

  test("取り込み：.InsightMaker と ModelJSON", async () => {
    const im = await call("import_model", { path: path.join(FIXTURES_DIR, "population.InsightMaker") });
    expect(im.model).toBe("population");
    expect(im.validation.ok).toBe(true);
    expect(im.summary.stocks[0].name).toBe("Population");

    const json = await call("import_model", { path: path.join(SAMPLES_DIR, "predator_prey.json"), model: "pp" });
    expect(json.model).toBe("pp");
    const run = await call("run_simulation", { model: "pp", samples: 0 });
    expect(Object.keys(run.results).length).toBeGreaterThan(0);

    const content = await call("import_model", { content: '{"elements":[{"type":"VARIABLE","name":"x","behavior":{"value":1}}]}', model: "inline" });
    expect(content.validation.ok).toBe(true);

    expect(await callError("import_model", { path: "no/such/file.InsightMaker" })).toMatch(/読めません/);
    expect(await callError("import_model", { path: path.join(FIXTURES_DIR, "population.InsightMaker") })).toMatch(/すでにあります/);
  });

  test("実際のデータを取り込む。合わない列は「もしかして」を付けて知らせ、名前を変えると列名も直す", async () => {
    await call("create_model", { model: "sir", simulation: { time_length: 100 } });
    await call("upsert_elements", { model: "sir", elements: SIR });
    const csvPath = path.join(dir, "infected.csv");
    await writeFile(csvPath, "Day,infected,Recoverd\n0,10,0\n10,80,\n20,200,40\n", "utf8");

    const imported = await call("import_data", { model: "sir", path: csvPath });
    expect(path.basename(imported.file)).toBe("sir.data.csv");
    expect(imported).toMatchObject({ columns: ["Infected", "Recoverd"], rows: 3, time_range: [0, 20] });
    expect(imported.warnings).toHaveLength(1);
    expect(imported.warnings[0].hint).toMatch(/もしかして "Recovered"/);
    // 一覧には出さない
    expect((await call("list_models")).models.map((m: any) => m.name)).toEqual(["sir"]);

    const renamed = await call("upsert_elements", { model: "sir", elements: [{ name: "Infected", rename_to: "感染者" }] });
    expect(renamed.changes.notes.join("\n")).toMatch(/sir\.data\.csv/);
    expect((await readFile(imported.file, "utf8")).replace(/^﻿/, "").split("\n")[0]).toBe("Day,感染者,Recoverd");

    // CSV の列名を直せなくても（変えると列名が重なる）、モデルは保存して成功として返し、知らせを添える
    await writeFile(imported.file, "Day,感染者,Sick\n0,10,1\n", "utf8");
    const clash = await call("upsert_elements", { model: "sir", elements: [{ name: "感染者", rename_to: "Sick" }] });
    expect(clash.changes.notes.join("\n")).toMatch(/列名を直せませんでした/);
    expect((await call("get_model", { model: "sir", format: "full" })).elements.some((e: any) => e.name === "Sick")).toBe(true);
    await call("upsert_elements", { model: "sir", elements: [{ name: "Sick", rename_to: "感染者" }] });

    // content でも渡せる。Excel から貼ったタブ区切りも読む
    const pasted = await call("import_data", { model: "sir", content: "Day\t感染者\n0\t10\n" });
    expect(pasted.warnings).toEqual([]);
    expect(await callError("import_data", { model: "sir", content: "Day,感染者\nx,1\n" })).toMatch(/2 行目の時刻/);
    expect(await callError("import_data", { model: "none", content: "Day,A\n0,1\n" })).toMatch(/見つかりません/);
    expect(await callError("import_data", { model: "sir" })).toMatch(/path か content/);
  });

  test("会議資料の筋書きを保存し、名前を変えると筋書きの中も直す", async () => {
    await call("create_model", { model: "sir", simulation: { time_length: 100, time_units: "DAYS" } });
    await call("upsert_elements", { model: "sir", elements: SIR });
    await call("set_scenarios", { model: "sir", scenarios: [{ name: "外出を控える", description: "接触を半分にする", values: { "Contact Rate": 0.2 } }] });
    await call("import_data", { model: "sir", content: "Day,Infected\n0,10\n10,60\n" });
    // 原因のスライドのループ（Infected → Infection → Infected）が R だと決まるように、極性を入れる
    await call("upsert_elements", { model: "sir", elements: [{ type: "LINK", from: "Infected", to: "Infection", behavior: { polarity: "POSITIVE" } }] });
    const slides = [
      { kind: "problem", title: "感染が広がる", message: "このままだと半分近くが感染する", elements: ["infected"], data: ["Infected"], now: 10 },
      { kind: "cause", title: "うつす人が増えるほど広がる", message: "感染者が増えるほど新しい感染が増える", loop: { elements: ["Infected", "Infection"], polarity: "R" } },
      { kind: "solution", title: "外出を控える", message: "接触を減らす", scenario: "外出を控える" },
      { kind: "compare", title: "比べる", message: "山が低くなる", scenarios: ["外出を控える"], elements: ["Infected"], at: 40 },
      { kind: "conclusion", title: "結論", message: "外出を控えると山を低くできる" },
    ];

    // 名前が合わなければ保存せず、何枚目の何が合わないかを返す
    const bad = JSON.parse(await callError("set_slides", { model: "sir", slides: [{ ...slides[2], scenario: "外出を控る" }] }));
    expect(bad.error).toMatch(/保存しませんでした/);
    expect(bad.issues[0]).toMatchObject({ slide: 1 });
    expect(bad.issues[0].hint).toMatch(/もしかして "外出を控える"/);
    expect(await callError("set_slides", { model: "sir", slides: [{ kind: "chart", title: "a", message: "b" }] })).toMatch(/kind/);
    expect(await callError("view_slides", { model: "sir", image: false })).toMatch(/筋書きがありません/);
    expect(await callError("export_slides", { model: "sir" })).toMatch(/筋書きがありません/);

    const saved = await call("set_slides", { model: "sir", title: "感染症の対策", slides });
    expect(path.basename(saved.file)).toBe("sir.slides.json");
    expect(saved.slides).toEqual(["1. 問題：感染が広がる", "2. 原因：うつす人が増えるほど広がる", "3. 解決案：外出を控える", "4. 比較：比べる", "5. 結論：結論"]);
    expect(saved.warnings).toEqual([]);
    // 一覧には出さない
    expect((await call("list_models")).models.map((m: any) => m.name)).toEqual(["sir"]);
    const viewed = await call("view_slides", { model: "sir", image: false });
    expect(viewed).toMatchObject({ title: "感染症の対策", version: saved.version, errors: [] });
    // 表記はモデルにそろえて保存する
    expect(viewed.slides[0].elements).toEqual(["Infected"]);

    // 要素とシナリオの名前を変えると、筋書きの中も直す
    const renamed = await call("upsert_elements", { model: "sir", elements: [{ name: "Infected", rename_to: "感染者" }] });
    expect(renamed.changes.notes.join("\n")).toMatch(/sir\.slides\.json/);
    const scenario = await call("set_scenarios", { model: "sir", scenarios: [{ name: "外出を控える", rename_to: "外出の自粛" }] });
    expect(scenario.changes.notes.join("\n")).toMatch(/sir\.slides\.json/);
    const after = await call("view_slides", { model: "sir", image: false });
    expect(after.errors).toEqual([]);
    expect(after.slides[0]).toMatchObject({ elements: ["感染者"], data: ["感染者"] });
    expect(after.slides[1].loop.elements).toEqual(["感染者", "Infection"]);
    expect(after.slides[2].scenario).toBe("外出の自粛");
    expect(after.slides[3]).toMatchObject({ scenarios: ["外出の自粛"], elements: ["感染者"] });

    // 期間を縮めて注目する時点が外に出たり、実際のデータの列がなくなったりしたら知らせる
    const shorter = await call("set_simulation", { model: "sir", time_length: 30 });
    expect(shorter.slides_issues.map((i: any) => i.message).join("\n")).toMatch(/4 枚目.*注目する時点（40）/);
    expect((await call("set_simulation", { model: "sir", time_length: 100 })).slides_issues).toBeUndefined();
    const replaced = await call("import_data", { model: "sir", content: "Day,Recovered\n0,0\n" });
    expect(replaced.slides_issues.map((i: any) => i.message).join("\n")).toMatch(/1 枚目.*列 "感染者" がありません/);
    expect((await call("import_data", { model: "sir", content: "Day,感染者\n0,10\n" })).slides_issues).toBeUndefined();

    // 筋書きが使っているシナリオを消すと、そのことを知らせる
    const removed = await call("set_scenarios", { model: "sir", remove: ["外出の自粛"] });
    expect(removed.slides_issues.map((i: any) => i.slide)).toEqual([3, 4]);
    // 合わないところがあれば、PDF に書き出さない
    const notExported = JSON.parse(await callError("export_slides", { model: "sir" }));
    expect(notExported.error).toMatch(/書き出しませんでした/);
    expect(notExported.issues.map((i: any) => i.slide)).toEqual([3, 4]);

    // 版が違えば保存しない
    expect(await callError("set_slides", { model: "sir", slides: [slides[4]], version: "0000" })).toMatch(/ほかのところで変わって/);
    const ok = await call("set_slides", { model: "sir", slides: [slides[4]], version: after.version });
    expect(ok.version).not.toBe(after.version);
    expect(await callError("view_slides", { model: "sir", slides: [3] })).toMatch(/スライド 3 はありません/);
  });

  test("エラーは直し方つきで返す", async () => {
    expect(await callError("get_model", { model: "none" })).toMatch(/見つかりません/);
    expect(await callError("get_model", { model: "../x" })).toMatch(/使えない文字/);
    await call("create_model", { model: "e" });
    expect(await callError("upsert_elements", { model: "e", elements: [{ name: "x" }] })).toMatch(/type が必要/);
    const bad = await call("upsert_elements", { model: "e", elements: [{ type: "VARIABLE", name: "x", behavior: { value: "1 +* 2" } }] });
    expect(bad.validation.ok).toBe(false);
    const err = JSON.parse(await callError("run_simulation", { model: "e" }));
    expect(err.issues[0].element).toBe("x");
    expect(await callError("export_model", { model: "e", path: "../../outside.json" })).toMatch(/外を指して/);
    await call("set_slides", { model: "e", slides: [{ kind: "conclusion", title: "結論", message: "まとめ" }] });
    expect(await callError("export_slides", { model: "e", path: "../../outside.pdf" })).toMatch(/外を指して/);
    // どのエラーも { error } の JSON で返る
    expect(JSON.parse(await callError("get_model", { model: "none" })).error).toMatch(/見つかりません/);
    expect(JSON.parse(await callError("upsert_elements", { model: "e", elements: [{ name: "z" }] })).error).toMatch(/type が必要/);
  });

  test("時系列の [時刻, 値] は 1 行にまとめて返す", async () => {
    await call("create_model", { model: "g", simulation: { time_length: 10 } });
    await call("upsert_elements", {
      model: "g",
      elements: [
        { type: "STOCK", name: "P", behavior: { initial_value: 1 } },
        { type: "FLOW", name: "F", to: "P", behavior: { value: "[P]*0.1" } },
      ],
    });
    const res = await client.callTool({ name: "run_simulation", arguments: { model: "g", samples: 3 } });
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/"series": \[\[0,1\],\[5,[\d.]+\],\[10,[\d.]+\]\]/);
    expect(JSON.parse(text).results.P.series).toHaveLength(3);
    const summary = await call("get_model", { model: "g" });
    expect(summary).toMatchObject({ model: "g", title: "g" });
    expect(summary.flows[0]).toMatchObject({ name: "F", from: null, to: "P" });
  });

  test("式のないモデルを実行すると、結果に警告を添える", async () => {
    await call("create_model", { model: "cld" });
    await call("upsert_elements", { model: "cld", elements: [{ type: "VARIABLE", name: "A" }, { type: "VARIABLE", name: "B" }] });
    const run = await call("run_simulation", { model: "cld", samples: 0 });
    expect(run.warnings[0].message).toMatch(/因果ループ図/);
  });

  test("layout_model で座標を付けて保存し、view_diagram で図の確認の一覧を返す", async () => {
    await call("create_model", { model: "sir" });
    await call("upsert_elements", { model: "sir", elements: SIR });
    const before = await call("view_diagram", { model: "sir", image: false });
    expect(before.missing_coordinates).toBe(true);

    const laid = await call("layout_model", { model: "sir" });
    expect(laid.placed_elements.length).toBeGreaterThan(0);
    expect(laid.diagram.missing_coordinates).toBe(false);
    expect(laid.diagram.overlaps).toEqual([]);

    const check = await call("view_diagram", { model: "sir", image: false });
    expect(check.missing_coordinates).toBe(false);
    const s = check.positions.find((p: { name: string }) => p.name === "Susceptible");
    expect(s.coordinates).toHaveLength(2);
    expect(check.how_to_move).toMatch(/upsert_elements/);

    // 動かすと一覧に出る
    await call("upsert_elements", { model: "sir", elements: [{ name: "Infected", display: { coordinates: s.coordinates } }] });
    const moved = await call("view_diagram", { model: "sir", image: false });
    expect(moved.overlaps.join()).toMatch(/Susceptible と Infected|Infected と Susceptible/);

    // reset で並べ直すと重なりはなくなる
    const reset = await call("layout_model", { model: "sir", reset: true });
    expect(reset.diagram.overlaps).toEqual([]);
  });

  test("view_diagram は図を PNG で返す（ブラウザと画面のビルドがあるとき）", async () => {
    await call("create_model", { model: "p" });
    await call("upsert_elements", { model: "p", elements: SIR });
    const res = await client.callTool({ name: "view_diagram", arguments: { model: "p", width: 800, height: 500 } });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const info = JSON.parse(content[0]!.text!);
    if (info.image_error) {
      // ブラウザか画面のビルドがない環境では、一覧だけを返す
      expect(info.image_error).toMatch(/Edge か Chrome|ビルド/);
      return;
    }
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const png = Buffer.from(content[1]!.data!, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  }, 30_000);

  test("find_loops で brooks_law のループと R / B を返し、view_diagram の loop で目立たせる", async () => {
    await call("import_model", { path: path.join(FIXTURES_DIR, "brooks_law.json"), model: "brooks" });
    const unknown = await call("find_loops", { model: "brooks", element: "全員の人数", max_length: 3 });
    expect(unknown.loops).toEqual([
      {
        name: "?1",
        kind: "unknown",
        elements: ["新人", "全員の人数", "採用"],
        steps: ["新人 → 全員の人数 (?)", "全員の人数 → 採用 (?)", "採用 → 新人 (+, フロー)"],
        undetermined: ["新人 → 全員の人数 (?)", "全員の人数 → 採用 (?)"],
      },
    ]);
    expect(unknown.hint).toMatch(/polarity/);

    await call("upsert_elements", {
      model: "brooks",
      elements: [
        { from: "新人", to: "全員の人数", behavior: { polarity: "POSITIVE" } },
        { from: "全員の人数", to: "採用", behavior: { polarity: "NEGATIVE" } },
      ],
    });
    const found = await call("find_loops", { model: "brooks", element: "全員の人数", max_length: 3 });
    expect(found.loops[0]).toMatchObject({ name: "B1", kind: "B" });
    expect(found.loops[0].undetermined).toBeUndefined();
    expect(found.count).toEqual({ R: 0, B: 1, unknown: 0 });
    expect(found.hint).toBeUndefined();

    const view = await call("view_diagram", { model: "brooks", image: false, loop: { elements: found.loops[0].elements, name: "採用で人数をそろえる" } });
    expect(view.loop).toMatchObject({ name: "採用で人数をそろえる", kind: "B", elements: ["新人", "全員の人数", "採用"] });
    expect(await callError("view_diagram", { model: "brooks", image: false, loop: { elements: ["新人", "採用"] } })).toMatch(/ループになっていません/);
    expect(await callError("find_loops", { model: "brooks", element: "新入" })).toMatch(/"新入.*見つかりません。もしかして.*新人/);
  });

  test("view_slides はスライドを 1 枚ずつ PNG で返す（ブラウザと画面のビルドがあるとき）", async () => {
    await call("create_model", { model: "p" });
    await call("upsert_elements", { model: "p", elements: SIR });
    await call("set_slides", {
      model: "p",
      slides: [
        { kind: "problem", title: "感染が広がる", message: "山ができる", elements: ["Infected"] },
        { kind: "conclusion", title: "結論", message: "対策が要る" },
      ],
    });
    const res = await client.callTool({ name: "view_slides", arguments: { model: "p", width: 800 } });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    const info = JSON.parse(content[0]!.text!);
    if (info.image_error) {
      expect(info.image_error).toMatch(/Edge か Chrome|ビルド/);
      return;
    }
    expect(content.slice(1).map((c) => (c.type === "text" ? c.text : c.mimeType))).toEqual(["スライド 1", "image/png", "スライド 2", "image/png"]);
    const png = Buffer.from(content[2]!.data!, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // 16:9 の高さ（PNG の IHDR の幅と高さ）
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 450]);
  }, 60_000);

  test("export_slides は 1 スライド 1 ページの PDF を書き出す（ブラウザと画面のビルドがあるとき）", async () => {
    await call("create_model", { model: "p" });
    await call("upsert_elements", { model: "p", elements: SIR });
    await call("set_slides", {
      model: "p",
      slides: [
        { kind: "problem", title: "感染が広がる", message: "山ができる", elements: ["Infected"] },
        { kind: "cause", title: "うつす人が増える", message: "感染者が増えるほど広がる", loop: { elements: ["Infected", "Infection"], polarity: "R" } },
        { kind: "conclusion", title: "結論", message: "対策が要る" },
      ],
    });
    const res = await client.callTool({ name: "export_slides", arguments: { model: "p", path: "out/会議" } });
    const text = (res.content as { text: string }[])[0]!.text;
    if (res.isError) {
      // ブラウザか画面のビルドがない環境では、書き出せないことを知らせる
      expect(JSON.parse(text).error).toMatch(/Edge か Chrome|ビルド/);
      return;
    }
    const out = JSON.parse(text);
    expect(out.file).toBe(path.join(dir, "out", "会議.pdf"));
    expect(out.pages).toBe(3);
    const pdf = (await readFile(out.file)).toString("latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    // 1 スライド 1 ページで、どのページも 16:9（13.33 × 7.5 インチ = 960 × 540 ポイント）
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(3);
    expect(pdf.match(/\/MediaBox \[[^\]]*\]/g)).toEqual(Array(3).fill("/MediaBox [0 0 960 540]"));
    // フォントを埋め込み、ビューア（127.0.0.1）へのリンクを残さない
    expect(pdf).toMatch(/\/FontFile2?\b/);
    expect(pdf).not.toMatch(/127\.0\.0\.1|\/URI/);
  }, 60_000);
});
