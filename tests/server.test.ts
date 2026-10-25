import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../src/mcp/server.js";
import { type ModelJSON } from "../src/core/index.js";
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
  test("クライアントから接続でき、21 個のツールが見える", async () => {
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toMatch(/ModelJSON/);
    // スライドの機能は削除したので、説明文にも出さない
    expect(client.getInstructions()).not.toMatch(/slides|説明資料|発表モード|筋書き/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "create_folder",
        "create_model",
        "find_loops",
        "get_model",
        "import_data",
        "import_model",
        "layout_model",
        "list_models",
        "move_folder",
        "move_model",
        "remove_elements",
        "remove_folder",
        "remove_model",
        "run_simulation",
        "set_groups",
        "set_scenarios",
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

  test("取り込み：ModelJSON", async () => {
    const json = await call("import_model", { path: path.join(SAMPLES_DIR, "predator_prey.json") });
    expect(json.model).toBe("predator_prey");
    expect(json.validation.ok).toBe(true);
    await call("import_model", { path: path.join(SAMPLES_DIR, "predator_prey.json"), model: "pp" });
    const run = await call("run_simulation", { model: "pp", samples: 0 });
    expect(Object.keys(run.results).length).toBeGreaterThan(0);

    const content = await call("import_model", { content: '{"elements":[{"type":"VARIABLE","name":"x","behavior":{"value":1}}]}', model: "inline" });
    expect(content.validation.ok).toBe(true);

    expect(await callError("import_model", { content: "<InsightMakerModel></InsightMakerModel>", model: "xml" })).toMatch(/ModelJSON/);
    expect(await callError("import_model", { path: "no/such/file.json" })).toMatch(/読めません/);
    expect(await callError("import_model", { path: path.join(SAMPLES_DIR, "predator_prey.json") })).toMatch(/すでにあります/);
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

  test("エラーは直し方つきで返す", async () => {
    expect(await callError("get_model", { model: "none" })).toMatch(/見つかりません/);
    expect(await callError("get_model", { model: "../x" })).toMatch(/使えない文字/);
    await call("create_model", { model: "e" });
    expect(await callError("upsert_elements", { model: "e", elements: [{ name: "x" }] })).toMatch(/type が必要/);
    const bad = await call("upsert_elements", { model: "e", elements: [{ type: "VARIABLE", name: "x", behavior: { value: "1 +* 2" } }] });
    expect(bad.validation.ok).toBe(false);
    const err = JSON.parse(await callError("run_simulation", { model: "e" }));
    expect(err.issues[0].element).toBe("x");
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

  test("set_groups でグループを保存し、layout_model で集めて並べ、view_diagram でグループの確認を返す", async () => {
    await call("create_model", { model: "sir" });
    await call("upsert_elements", { model: "sir", elements: SIR });
    const saved = await call("set_groups", {
      model: "sir",
      groups: [
        { name: "うつる側", color: "pink", elements: ["Susceptible", "Infection", "Contact Rate"] },
        { name: "治る側", elements: ["Recovered", "Recovery", "Recovery Rate"] },
      ],
    });
    expect(saved.groups).toEqual([
      { name: "うつる側", color: "pink", elements: ["Susceptible", "Infection", "Contact Rate"] },
      { name: "治る側", color: "yellow", elements: ["Recovered", "Recovery", "Recovery Rate"] },
    ]);
    expect(saved.next_step).toMatch(/view_diagram/);
    expect(await callError("set_groups", { model: "sir", groups: [{ name: "x", color: "red" }] })).toMatch(/color|red/);
    expect(await callError("set_groups", { model: "sir", groups: [{ name: "x", elements: ["Nope"] }] })).toMatch(/見つかりません/);
    expect(await callError("set_groups", { model: "sir" })).toMatch(/groups か remove/);

    const laid = await call("layout_model", { model: "sir", reset: true });
    expect(laid.diagram.group_issues.filter((s: string) => s.includes("囲みが重なる"))).toEqual([]);
    const check = await call("view_diagram", { model: "sir", image: false });
    expect(check.groups.map((g: { name: string }) => g.name)).toEqual(["うつる側", "治る側"]);
    // グループがあっても実行できる
    expect((await call("validate_model", { model: "sir" })).ok).toBe(true);
    expect((await call("get_model", { model: "sir" })).groups).toHaveLength(2);

    // 要素の名前を変えると、グループの中身も変わる
    await call("upsert_elements", { model: "sir", elements: [{ name: "Recovered", rename_to: "回復した人" }] });
    const renamed = await call("set_groups", { model: "sir", groups: [{ name: "治る側", color: "teal" }] });
    expect(renamed.groups[1]).toEqual({ name: "治る側", color: "teal", elements: ["回復した人", "Recovery", "Recovery Rate"] });
    const removed = await call("set_groups", { model: "sir", remove: ["うつる側", "治る側"] });
    expect(removed.groups).toEqual([]);
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

  test("upsert_elements の display.delay で遅れの印を付け、find_loops と view_diagram と get_model に出す", async () => {
    await call("import_model", { path: path.join(FIXTURES_DIR, "bullwhip.json"), model: "bullwhip" });
    // 式で遅れて効くのに印のないリンクを知らせる
    const before = await call("view_diagram", { model: "bullwhip", image: false });
    expect(before.unmarked_delays.links).toContain("小売の発注 → 卸から小売への出荷");
    expect(before.unmarked_delays.hint).toMatch(/display:\{delay:true\}/);

    const res = await call("upsert_elements", {
      model: "bullwhip",
      elements: [
        { from: "小売の在庫", to: "小売の発注", behavior: { polarity: "NEGATIVE" } },
        { from: "小売の発注", to: "卸から小売への出荷", behavior: { polarity: "POSITIVE" }, display: { delay: true } },
      ],
    });
    // 印を付けても実行できる（エンジンには渡さない）
    expect(res.validation.ok).toBe(true);
    const after = await call("view_diagram", { model: "bullwhip", image: false });
    expect(after.unmarked_delays.links).not.toContain("小売の発注 → 卸から小売への出荷");

    const loops = await call("find_loops", { model: "bullwhip", element: "小売の発注", max_length: 3 });
    const loop = loops.loops.find((l: { elements: string[] }) => l.elements.includes("卸から小売への出荷"));
    expect(loop).toMatchObject({ kind: "B", delays: ["小売の発注 → 卸から小売への出荷 (+, 遅れ ‖)"] });

    const summary = await call("get_model", { model: "bullwhip" });
    expect(summary.links).toContain("小売の発注 → 卸から小売への出荷 (+) ‖遅れ");
    const run = await call("run_simulation", { model: "bullwhip", targets: ["小売の在庫"], samples: 3 });
    expect(run.error).toBeUndefined();

    expect(await callError("upsert_elements", { model: "bullwhip", elements: [{ name: "小売の在庫", display: { delay: true } }] })).toMatch(/LINK と FLOW だけ/);
  });
});

describe("フォルダに分けたモデル", () => {
  test("「フォルダ/名前」でモデルを作り、今までどおり読み書き・実行でき、list_models でフォルダが分かる", async () => {
    const made = await call("create_model", { model: "ブルックスの法則/brooks_law" });
    expect(made.file).toBe(path.join(dir, "ブルックスの法則", "brooks_law.json"));
    await call("upsert_elements", { model: "ブルックスの法則/brooks_law", elements: SIR });
    expect(await call("get_model", { model: "ブルックスの法則/brooks_law" })).toMatchObject({ model: "ブルックスの法則/brooks_law", title: "brooks_law" });
    const run = await call("run_simulation", { model: "ブルックスの法則/brooks_law", elements: ["Infected"], samples: 0 });
    expect(run.model).toBe("ブルックスの法則/brooks_law");
    const data = await call("import_data", { model: "ブルックスの法則/brooks_law", content: "Day,Infected\n0,10\n" });
    expect(data.file).toBe(path.join(dir, "ブルックスの法則", "brooks_law.data.csv"));
    // 中身に名前のない ModelJSON をフォルダに取り込むと、表示名はフォルダを除いた名前（create_model と同じ）
    await call("import_model", { model: "取り込み/inline", content: JSON.stringify({ elements: [] }) });
    expect(await call("get_model", { model: "取り込み/inline" })).toMatchObject({ title: "inline" });
    await call("remove_model", { model: "取り込み/inline" });
    await call("remove_folder", { folder: "取り込み" });
    await call("create_model", { model: "coffee" });
    await call("create_folder", { folder: "あとで" });
    const list = await call("list_models");
    expect(list.models.map((m: any) => [m.name, m.folder])).toEqual([
      ["coffee", ""],
      ["ブルックスの法則/brooks_law", "ブルックスの法則"],
    ]);
    expect(list.folders).toEqual([
      { name: "あとで", models: 0 },
      { name: "ブルックスの法則", models: 1 },
    ]);
    // 作業フォルダの外を指す名前は断る
    expect(await callError("create_model", { model: "../outside" })).toMatch(/使えない文字/);
    expect(await callError("create_folder", { folder: "a/../../x" })).toMatch(/使えない文字/);
  });

  test("move_model・move_folder・remove_folder・remove_model で、付属のファイルごと動かしたり消したりする", async () => {
    await call("create_model", { model: "bullwhip" });
    await call("upsert_elements", { model: "bullwhip", elements: SIR });
    await call("import_data", { model: "bullwhip", content: "Day,Infected\n0,10\n" });
    const moved = await call("move_model", { model: "bullwhip", to: "在庫/bullwhip" });
    expect(moved).toMatchObject({ model: "在庫/bullwhip", from: "bullwhip" });
    expect((await readdir(path.join(dir, "在庫"))).sort()).toEqual(["bullwhip.data.csv", "bullwhip.json"]);
    await call("create_model", { model: "bullwhip" });
    expect(await callError("move_model", { model: "bullwhip", to: "在庫/bullwhip" })).toMatch(/同じ名前/);

    const folder = await call("move_folder", { folder: "在庫", to: "事例/在庫" });
    expect(folder.models).toEqual(["事例/在庫/bullwhip"]);
    expect((await call("validate_model", { model: "事例/在庫/bullwhip" })).ok).toBe(true);
    expect(await callError("remove_folder", { folder: "事例" })).toMatch(/ファイルがある/);

    const removed = await call("remove_model", { model: "事例/在庫/bullwhip" });
    expect(removed.files.map((f: string) => path.basename(f)).sort()).toEqual(["bullwhip.data.csv", "bullwhip.json"]);
    await call("remove_folder", { folder: "事例" });
    expect((await readdir(dir)).sort()).toEqual(["bullwhip.json"]);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "remove_model")!.description).toMatch(/使う前に.*人に.*確かめる/);
  });
});
