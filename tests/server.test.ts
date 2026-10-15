import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../src/mcp/server.js";
import { validateModel, type ModelJSON } from "../src/core/index.js";
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
  test("クライアントから接続でき、13 個のツールが見える", async () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toMatch(/ModelJSON/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_model",
        "export_model",
        "get_model",
        "import_model",
        "layout_model",
        "list_models",
        "remove_elements",
        "run_simulation",
        "set_simulation",
        "sweep_parameter",
        "upsert_elements",
        "validate_model",
        "view_diagram",
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
    }
    // グラフの設定がないので、ストックの時系列グラフが足される
    expect(exp.added_chart).toMatchObject({ type: "TIME_SERIES", elements: ["Susceptible", "Infected", "Recovered"] });
    expect(exported.visualizations).toEqual([exp.added_chart]);
    // save_layout を付けなければモデル本体には座標を書かない。グラフも書かない
    const after = await call<ModelJSON>("get_model", { model: "sir", format: "full" });
    expect(after.elements.some((e) => e.display?.coordinates)).toBe(false);
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
});
