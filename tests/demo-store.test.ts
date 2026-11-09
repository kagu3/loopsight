// デモサイト（npm run build:demo）の「サーバーの代わり」（web/src/demo/store.ts）を確かめる。
// 返す形と動きが、ビューアのサーバー（src/viewer/server.ts）とずれていないことも、同じ書き込みを両方に送って比べる
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { EditErrorResponse, EditResponse, ModelResponse } from "../src/viewer/api.js";
import { startViewer, type Viewer } from "../src/viewer/server.js";
import { DemoStore } from "../web/src/demo/store.js";
import { tempDir } from "./helpers.js";

const EXAMPLES_DIR = path.resolve("examples");

/** examples/ の sample（モデル名 → 中身）。web/src/demo/samples.ts と同じ名前の付け方 */
function samples(): Record<string, string> {
  const ext = ".json";
  const out: Record<string, string> = {};
  for (const folder of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const file of readdirSync(path.join(EXAMPLES_DIR, folder.name))) {
      if (file.endsWith(ext)) out[`${folder.name}/${file.slice(0, -ext.length)}`] = readFileSync(path.join(EXAMPLES_DIR, folder.name, file), "utf8");
    }
  }
  return out;
}

const COFFEE = "0_コーヒーが冷める/coffee-cooling";

/** 実際のデータ（.data.csv）を試すモデル。examples/ の sample にはデータがないので、tests/fixtures/ のものを使う */
const POPULATION = "population";
const fixture = (file: string) => readFileSync(path.join("tests/fixtures", file), "utf8");

describe("デモのモデル（ブラウザの中で読み書きする）", () => {
  test("sample をフォルダの番号の順に並べ、最初のモデルを開ける", () => {
    const store = new DemoStore(samples());
    const list = store.list();
    expect(list.models[0]!.name).toBe(COFFEE);
    expect(list.folders.map((f) => f.name)).toEqual([...list.folders.map((f) => f.name)].sort((a, b) => a.localeCompare(b, "ja", { numeric: true })));
    expect(list.folders.find((f) => f.name === "6_ブルウィップ効果")?.models).toBe(2);
    // 画面は「いちばん最近変わったモデル」を開く。どれも同じ時刻なので、一覧の最初（0 の sample）になる
    expect(new Set(list.models.map((m) => m.modified)).size).toBe(1);
    for (const m of list.models) {
      const res = store.get(m.name);
      expect(res.validation.ok, m.name).toBe(true);
      expect(res.run, m.name).toBeDefined();
    }
  });

  test("値を変える → 結果が変わる。元に戻すと、元の版と結果に戻る", () => {
    const store = new DemoStore(samples());
    const before = store.get(COFFEE);
    const name = before.model.elements.find((e) => e.type === "VARIABLE")!.name!;
    const edit = store.write(COFFEE, "edit", { version: before.version, elements: [{ type: "VARIABLE", name, behavior: { value: 0.05 } }] } as never);
    expect(edit.status).toBe(200);
    const after = (edit.body as EditResponse).model;
    expect(after.undo_available).toBe(1);
    expect(after.run!.series).not.toEqual(before.run!.series);
    const undo = store.write(COFFEE, "undo", { version: after.version } as never);
    expect(undo.status).toBe(200);
    const back = (undo.body as EditResponse).model;
    expect(back.version).toBe(before.version);
    expect(back.undo_available).toBe(0);
    expect(back.run!.series).toEqual(before.run!.series);
    // ほかのモデルの記録とは分ける
    expect(store.write(COFFEE, "undo", { version: back.version } as never)).toMatchObject({ status: 400, body: { error: "元に戻せる変更がありません。" } });
  });

  test("シナリオを足す・直す。版が古いと書き込まない。見つからないモデルは 404", () => {
    const store = new DemoStore(samples());
    const v0 = store.get(COFFEE).version;
    const add = store.write(COFFEE, "scenarios", { version: v0, scenarios: [{ name: "テスト", description: "試し" }] } as never);
    expect(add.status).toBe(200);
    const res = (add.body as EditResponse).model;
    expect(res.scenarios?.some((s) => s.name === "テスト")).toBe(true);
    const stale = store.write(COFFEE, "scenarios", { version: v0, scenarios: [{ name: "テスト 2" }] } as never);
    expect(stale.status).toBe(409);
    expect((stale.body as EditErrorResponse).current?.version).toBe(res.version);
    expect(store.write(COFFEE, "edit", { version: res.version, elements: "x" } as never).status).toBe(400);
    expect(() => store.get("ない")).toThrow(/見つかりません/);
  });

  test("実際のデータ（.data.csv）をグラフ用に返す。要素の名前を変えると、列名も直り、元に戻すと戻る", () => {
    const data = { [POPULATION]: fixture("population.data.csv") };
    const store = new DemoStore({ ...samples(), [POPULATION]: fixture("population.json") }, data);
    const before = store.get(POPULATION);
    expect(before.actual).toMatchObject({ file: "population.data.csv", issues: [] });
    expect(before.actual!.times[0]).toBe(0);
    expect(before.actual!.series["Population"]![0]).toBe(1000);
    // データのない sample には付けない。モデルのないデータは使わない
    expect(store.get(COFFEE).actual).toBeUndefined();
    expect(new DemoStore({ [POPULATION]: fixture("population.json") }, { ない: data[POPULATION]! }).get(POPULATION).actual).toBeUndefined();

    const edit = store.write(POPULATION, "edit", { version: before.version, elements: [{ type: "STOCK", name: "Population", rename_to: "人口" }] } as never);
    expect(edit.status).toBe(200);
    const body = edit.body as EditResponse;
    expect(body.report && "notes" in body.report ? body.report.notes : []).toContain("実際のデータ（population.data.csv）の列名も直しました。");
    expect(Object.keys(body.model.actual!.series)).toEqual(["人口", "Births"]);
    const undo = store.write(POPULATION, "undo", { version: body.model.version } as never);
    expect(Object.keys((undo.body as EditResponse).model.actual!.series)).toEqual(["Population", "Births"]);
  });

  test("読み直す（作り直す）と、元の sample に戻る", () => {
    const models = samples();
    const store = new DemoStore(models);
    const v0 = store.get(COFFEE).version;
    store.write(COFFEE, "simulation", { version: v0, simulation: { time_length: 30 } } as never);
    expect(store.get(COFFEE).version).not.toBe(v0);
    expect(new DemoStore(models).get(COFFEE).version).toBe(v0);
  });
});

describe("デモとビューアのサーバーで、同じ書き込みの結果が同じになる", () => {
  let viewer: Viewer | undefined;
  afterEach(async () => {
    await viewer?.close();
    viewer = undefined;
  });

  test("要素の編集・削除・シナリオ・グループ・シミュレーションの設定・元に戻す", async () => {
    // 実際のデータの列名を直すところまで比べるため、データのある tests/fixtures/ のモデルを使う
    const text = fixture("population.json");
    const data = fixture("population.data.csv");
    const dir = await tempDir();
    await writeFile(path.join(dir, `${POPULATION}.json`), text);
    await writeFile(path.join(dir, `${POPULATION}.data.csv`), data);
    viewer = await startViewer({ modelsDir: dir, port: 0 });
    const url = (p: string) => new URL(`/api/models/${encodeURIComponent(POPULATION)}${p}`, viewer!.url);
    const post = async (action: string, body: object) => {
      const res = await fetch(url(`/${action}`), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-IM-Viewer": "1" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as EditResponse & EditErrorResponse };
    };
    const store = new DemoStore({ [POPULATION]: text }, { [POPULATION]: data });
    const server0 = (await (await fetch(url(""))).json()) as ModelResponse;
    const variable = server0.model.elements.find((e) => e.type === "VARIABLE")!.name!;
    const stock = server0.model.elements.find((e) => e.type === "STOCK")!.name!;
    const steps: [string, object][] = [
      ["edit", { elements: [{ type: "VARIABLE", name: variable, behavior: { value: 0.05 } }] }],
      ["edit", { elements: [{ type: "VARIABLE", name: variable, rename_to: `${variable}2` }] }],
      // 実際のデータの列名も直る
      ["edit", { elements: [{ type: "STOCK", name: stock, rename_to: `${stock}2` }] }],
      ["scenarios", { scenarios: [{ name: "比べる", values: { [`${variable}2`]: 0.01 } }] }],
      // 何も変えない実行の名前と説明（シナリオと同じ名前は断る）
      ["scenarios", { scenarios: [], baseline: { name: "今のまま", description: "何も変えない" } }],
      ["scenarios", { scenarios: [], baseline: { name: "比べる" } }],
      ["groups", { groups: [{ name: "まとまり", elements: [`${stock}2`] }] }],
      ["simulation", { simulation: { time_length: 60 } }],
      ["remove", { elements: [{ name: `${stock}2` }] }],
      ["edit", { elements: [{ type: "VARIABLE", name: "おかしい", behavior: { value: "[ない]" } }] }],
      ["undo", {}],
      ["undo", {}],
      ["scenarios", { scenarios: [] }],
    ];
    let serverVersion = server0.version;
    let demoVersion = store.get(POPULATION).version;
    for (const [action, body] of steps) {
      const s = await post(action, { version: serverVersion, ...body });
      const d = store.write(POPULATION, action as never, { version: demoVersion, ...body } as never);
      expect(d.status, `${action} ${JSON.stringify(body)}`).toBe(s.status);
      const sb = s.body;
      const db = d.body as EditResponse & EditErrorResponse;
      expect(db.error).toBe(sb.error);
      expect(db.report).toEqual(sb.report);
      expect(db.renamed).toEqual(sb.renamed);
      if (s.status !== 200) continue;
      // 版の作り方（ハッシュ）と時刻はサーバーとデモで違う。中身と実行結果が同じことを比べる
      expect(db.model.model).toEqual(sb.model.model);
      expect(db.model.validation).toEqual(sb.model.validation);
      expect(db.model.run).toEqual(sb.model.run);
      expect(db.model.scenarios).toEqual(sb.model.scenarios);
      expect(db.model.run_error).toEqual(sb.model.run_error);
      expect(db.model.undo_available).toBe(sb.model.undo_available);
      // 実際のデータは、版（ハッシュ）の作り方だけが違う
      expect({ ...db.model.actual, version: undefined }).toEqual({ ...sb.model.actual, version: undefined });
      expect(db.warning).toBe(sb.warning);
      serverVersion = sb.model.version;
      demoVersion = db.model.version;
    }
  });
});
