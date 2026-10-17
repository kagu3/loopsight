import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelStore, emptyModel, toGraph, upsertElements } from "../src/core/index.js";
import type { ChangeEvent, EditErrorResponse, EditResponse, ModelListResponse, ModelResponse } from "../src/viewer/api.js";
import { startViewer, type Viewer } from "../src/viewer/server.js";
import { cellPatchOf, clearValuePatches, newScenarioPatchOf } from "../web/src/scenarios.js";
import { tempDir } from "./helpers.js";

let dir: string;
let viewer: Viewer;

function population() {
  const m = emptyModel("人口モデル", { time_length: 10, time_units: "YEARS" });
  upsertElements(m, [
    { type: "STOCK", name: "Population", behavior: { initial_value: 100 } },
    { type: "VARIABLE", name: "Rate", behavior: { value: 0.1 } },
    { type: "FLOW", name: "Births", to: "Population", behavior: { value: "[Population]*[Rate]" } },
  ]);
  return m;
}

async function get<T>(p: string): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(p, viewer.url));
  return { status: res.status, body: (await res.json()) as T };
}

async function post<T>(p: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(p, viewer.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-IM-Viewer": "1", Origin: viewer.url.replace(/\/$/, ""), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeEach(async () => {
  dir = await tempDir();
  await new ModelStore(dir).write("pop", population());
  const web = path.join(dir, "web");
  await mkdir(web);
  await writeFile(path.join(web, "index.html"), "<!doctype html><title>viewer</title>");
  viewer = await startViewer({ modelsDir: dir, staticDir: web, port: 0 });
});

afterEach(async () => {
  await viewer.close();
});

describe("ビューアのサーバー", () => {
  test("モデルの一覧を返す", async () => {
    const { status, body } = await get<ModelListResponse>("/api/models");
    expect(status).toBe(200);
    expect(body.models.map((m) => [m.name, m.title])).toEqual([["pop", "人口モデル"]]);
  });

  test("モデルと実行結果を返す", async () => {
    const { body } = await get<ModelResponse>("/api/models/pop");
    expect(body.validation.ok).toBe(true);
    expect(body.run!.times).toHaveLength(11);
    expect(body.run!.series.Population!.at(-1)).toBeCloseTo(100 * 1.1 ** 10, 6);
    expect(body.run!.series.Rate!.every((v) => v === 0.1)).toBe(true);
  });

  test("保存したシナリオも実行して、全時系列を返す", async () => {
    const m = population();
    m.scenarios = [
      { name: "高い", description: "増える割合を上げる", values: { Rate: 0.2 } },
      { name: "壊れた", values: { Rate: "[Nope]" } },
    ];
    await new ModelStore(dir).write("pop", m);
    const { body } = await get<ModelResponse>("/api/models/pop");
    expect(body.run!.series.Population!.at(-1)).toBeCloseTo(100 * 1.1 ** 10, 6);
    expect(body.scenarios!.map((s) => s.name)).toEqual(["高い", "壊れた"]);
    expect(body.scenarios![0]).toMatchObject({ description: "増える割合を上げる", values: { Rate: 0.2 } });
    expect(body.scenarios![0]!.series!.Population).toHaveLength(11);
    expect(body.scenarios![0]!.series!.Population!.at(-1)).toBeCloseTo(100 * 1.2 ** 10, 6);
    expect(body.scenarios![1]!.series).toBeUndefined();
    expect(body.scenarios![1]!.error).toBeTruthy();
    // 画面で重ねられる 8 つを超えたシナリオは実行せず、skipped で知らせる
    const many = population();
    many.scenarios = Array.from({ length: 9 }, (_, i) => ({ name: `s${i + 1}`, values: { Rate: 0.1 + i / 100 } }));
    await new ModelStore(dir).write("pop", many);
    const nine = (await get<ModelResponse>("/api/models/pop")).body.scenarios!;
    expect(nine.filter((s) => s.series)).toHaveLength(8);
    expect(nine[8]).toMatchObject({ name: "s9", skipped: true });
    expect(nine[8]!.series).toBeUndefined();
    // シナリオがなければ scenarios は付けない
    await new ModelStore(dir).write("pop", population());
    expect((await get<ModelResponse>("/api/models/pop")).body.scenarios).toBeUndefined();
  });

  test("エラーのあるモデルは実行せず、検証結果を返す", async () => {
    const m = population();
    m.elements.find((e) => e.name === "Births")!.behavior!.value = "[Population]*[Nope]";
    await new ModelStore(dir).write("broken", m);
    const { body } = await get<ModelResponse>("/api/models/broken");
    expect(body.validation.ok).toBe(false);
    expect(body.run).toBeUndefined();
  });

  test("ないモデルや作業フォルダの外は 404", async () => {
    expect((await get("/api/models/none")).status).toBe(404);
    expect((await get("/api/models/..%2Fsecret")).status).toBe(404);
  });

  test("画面のファイルを返し、知らないパスは index.html にする", async () => {
    const res = await fetch(new URL("/somewhere", viewer.url));
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/viewer/);
  });

  test("localhost 以外の Host は断る", async () => {
    const port = new URL(viewer.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/models", headers: { Host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  test("ファイルが変わると、そのモデル名をイベントで知らせる", async () => {
    const controller = new AbortController();
    const res = await fetch(new URL("/api/events", viewer.url), { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const received = (async () => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("イベントが届く前に切れた");
        text += decoder.decode(value);
        const m = text.match(/data: (.*)\n\n/);
        if (m) return JSON.parse(m[1]!) as ChangeEvent;
      }
    })();
    // 接続ができてから書き換える
    await new Promise((r) => setTimeout(r, 100));
    const m = population();
    m.elements.find((e) => e.name === "Rate")!.behavior!.value = 0.2;
    await new ModelStore(dir).write("pop", m);
    expect(await received).toEqual({ type: "changed", name: "pop" });
    controller.abort();
  });
});

describe("実際のデータ", () => {
  test("<モデル名>.data.csv があれば、要素に合う列を返し、合わない列は知らせる", async () => {
    expect((await get<ModelResponse>("/api/models/pop")).body.actual).toBeUndefined();
    await new ModelStore(dir).writeData("pop", "Year,population,Rat\n0,100,0.1\n5,170,\n");
    const { body } = await get<ModelResponse>("/api/models/pop");
    expect(body.actual).toMatchObject({ file: "pop.data.csv", times: [0, 5], series: { Population: [100, 170] } });
    expect(body.actual!.issues).toHaveLength(1);
    expect(body.actual!.issues[0]!.hint).toMatch(/もしかして "Rate"/);
    // 一覧には出さない
    expect((await get<ModelListResponse>("/api/models")).body.models.map((m) => m.name)).toEqual(["pop"]);
  });

  test("読めない CSV は、そのことを知らせる（モデルはそのまま出す）", async () => {
    await new ModelStore(dir).writeData("pop", "Year,Population\nabc,1\n");
    const { body } = await get<ModelResponse>("/api/models/pop");
    expect(body.run).toBeDefined();
    expect(body.actual!.issues[0]!.message).toMatch(/読めません.*2 行目/);
  });

  test("CSV が変わると、そのモデルが変わったとイベントで知らせる。モデルの版は変えず、データの版を変える", async () => {
    const before = (await get<ModelResponse>("/api/models/pop")).body;
    const controller = new AbortController();
    const res = await fetch(new URL("/api/events", viewer.url), { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const received = (async () => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("イベントが届く前に切れた");
        text += decoder.decode(value);
        const m = text.match(/data: (.*)\n\n/);
        if (m) return JSON.parse(m[1]!) as ChangeEvent;
      }
    })();
    // 接続ができてから書き換える
    await new Promise((r) => setTimeout(r, 100));
    await new ModelStore(dir).writeData("pop", "Year,Population\n0,100\n");
    expect(await received).toEqual({ type: "changed", name: "pop" });
    controller.abort();
    const first = (await get<ModelResponse>("/api/models/pop")).body;
    expect(first.version).toBe(before.version);
    await new ModelStore(dir).writeData("pop", "Year,Population\n0,120\n");
    const second = (await get<ModelResponse>("/api/models/pop")).body;
    expect(second.actual!.series.Population).toEqual([120]);
    expect(second.actual!.version).not.toBe(first.actual!.version);
  });

  test("画面で名前を変えると列名も直し、元に戻すと列名も戻す", async () => {
    const store = new ModelStore(dir);
    await store.writeData("pop", "Year,Population\n0,100\n");
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Population", rename_to: "人口" }] });
    expect(e1.status).toBe(200);
    expect(e1.body.model.actual!.series).toEqual({ 人口: [100] });
    expect(e1.body.model.actual!.issues).toEqual([]);
    const u = await post<EditResponse>("/api/models/pop/undo", { version: e1.body.model.version });
    expect(u.body.model.actual!.series).toEqual({ Population: [100] });
  });

  test("名前を変えた・元に戻したときは、変わった名前を返す（画面で選んでいる要素を合わせるため）", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Population", rename_to: "人口" }] });
    expect(e1.body.renamed).toEqual([["Population", "人口"]]);
    expect(e1.body.model.model.elements.find((e) => e.name === "Births")!.behavior!.value).toMatch(/\[人口\]/);
    const u = await post<EditResponse>("/api/models/pop/undo", { version: e1.body.model.version });
    expect(u.body.renamed).toEqual([["人口", "Population"]]);
    const e2 = await post<EditResponse>("/api/models/pop/edit", { version: u.body.model.version, elements: [{ name: "Population", behavior: { initial_value: 5 } }] });
    expect(e2.body.renamed).toBeUndefined();
  });

  test("列名を直せなくても、編集は保存して元に戻せるようにし、知らせを添える", async () => {
    const store = new ModelStore(dir);
    // 変えると列名が重なるので、CSV は直せない
    await store.writeData("pop", "Year,Population,人口\n0,100,1\n");
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Population", rename_to: "人口" }] });
    expect(e1.status).toBe(200);
    expect(e1.body.warning).toMatch(/列名を直せませんでした/);
    expect(e1.body.model.undo_available).toBe(1);
    expect((await store.read("pop")).elements.some((e) => e.name === "人口")).toBe(true);
    const u = await post<EditResponse>("/api/models/pop/undo", { version: e1.body.model.version });
    expect(u.status).toBe(200);
    expect(u.body.model.version).toBe(v0);
  });

  test("CSV だけがあってモデルがなければ、知らせない", async () => {
    const controller = new AbortController();
    const res = await fetch(new URL("/api/events", viewer.url), { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const received = (async () => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("イベントが届く前に切れた");
        text += decoder.decode(value);
        const m = text.match(/data: (.*)\n\n/);
        if (m) return JSON.parse(m[1]!) as ChangeEvent;
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await new ModelStore(dir).writeData("ghost", "Year,A\n0,1\n");
    // CSV の知らせが出るならこちらより先に届く
    await new Promise((r) => setTimeout(r, 400));
    await new ModelStore(dir).writeData("pop", "Year,Population\n0,1\n");
    expect(await received).toEqual({ type: "changed", name: "pop" });
    controller.abort();
  });
});

describe("会議資料の筋書き", () => {
  const deck = {
    slides: [
      { kind: "problem" as const, title: "増える", message: "増え続ける", elements: ["Population"], now: 5 },
      { kind: "cause" as const, title: "原因", message: "増えるほど生まれる", loop: { elements: ["Population", "Births"], polarity: "R" as const } },
    ],
  };

  test("<モデル名>.slides.json があれば、筋書きと、モデルに合わない名前を返す。一覧には出さない", async () => {
    expect((await get<ModelResponse>("/api/models/pop")).body.slides).toBeUndefined();
    const store = new ModelStore(dir);
    await store.writeSlides("pop", { slides: [...deck.slides, { kind: "compare", title: "比べる", message: "減る", scenarios: ["支援"], elements: ["Populaton"] }] });
    const { body } = await get<ModelResponse>("/api/models/pop");
    expect(body.slides).toMatchObject({ file: "pop.slides.json", deck: { slides: [{ kind: "problem" }, { kind: "cause" }, { kind: "compare" }] } });
    // 3 枚目は名前の誤り、1 枚目は実際のデータがないこと、2 枚目はループの極性がモデルで決まっていないこと
    expect(body.slides!.issues.map((i) => i.slide)).toEqual([3, 3, 1, 2]);
    expect(body.slides!.issues[0]!.hint).toMatch(/もしかして "Population"/);
    expect((await get<ModelListResponse>("/api/models")).body.models.map((m) => m.name)).toEqual(["pop"]);
    // 読めない筋書きは、そのことを知らせる（モデルはそのまま出す）
    await writeFile(store.slidesPathOf("pop"), "{ 壊れた", "utf8");
    const broken = (await get<ModelResponse>("/api/models/pop")).body;
    expect(broken.run).toBeDefined();
    expect(broken.slides!.deck).toBeUndefined();
    expect(broken.slides!.issues[0]!.message).toMatch(/筋書き.*を読めません/);
  });

  test("筋書きが変わると、そのモデルが変わったとイベントで知らせる。モデルの版は変えず、筋書きの版を変える", async () => {
    const store = new ModelStore(dir);
    await store.writeSlides("pop", deck);
    const before = (await get<ModelResponse>("/api/models/pop")).body;
    const controller = new AbortController();
    const res = await fetch(new URL("/api/events", viewer.url), { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const received = (async () => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("イベントが届く前に切れた");
        text += decoder.decode(value);
        const m = text.match(/data: (.*)\n\n/);
        if (m) return JSON.parse(m[1]!) as ChangeEvent;
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await store.writeSlides("pop", { slides: deck.slides.slice(0, 1) });
    expect(await received).toEqual({ type: "changed", name: "pop" });
    controller.abort();
    const after = (await get<ModelResponse>("/api/models/pop")).body;
    expect(after.version).toBe(before.version);
    expect(after.slides!.version).not.toBe(before.slides!.version);
    expect(after.slides!.deck!.slides).toHaveLength(1);
  });

  test("画面で名前を変えると筋書きの中も直し、元に戻すと筋書きも戻す", async () => {
    await new ModelStore(dir).writeSlides("pop", deck);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Population", rename_to: "人口" }] });
    expect(e1.status).toBe(200);
    expect(e1.body.report!.notes.join("\n")).toMatch(/pop\.slides\.json/);
    expect(e1.body.model.slides!.deck!.slides[1]).toMatchObject({ loop: { elements: ["人口", "Births"] } });
    expect(e1.body.model.slides!.issues.map((i) => i.message).join("\n")).not.toMatch(/モデルにありません/);
    const u = await post<EditResponse>("/api/models/pop/undo", { version: e1.body.model.version });
    expect(u.body.model.slides!.deck!.slides[0]).toMatchObject({ elements: ["Population"] });
  });
});

describe("ビューアからの編集", () => {
  test("要素を変えて保存し、新しい版と実行結果を返す", async () => {
    const before = (await get<ModelResponse>("/api/models/pop")).body;
    const { status, body } = await post<EditResponse>("/api/models/pop/edit", {
      version: before.version,
      elements: [{ name: "Rate", behavior: { value: 0.2 } }, { name: "Population", display: { coordinates: [300, 200] } }],
    });
    expect(status).toBe(200);
    expect(body.report!.updated).toEqual(['VARIABLE "Rate"', 'STOCK "Population"']);
    expect(body.model.version).not.toBe(before.version);
    expect(body.model.undo_available).toBe(1);
    expect(body.model.run!.series.Population!.at(-1)).toBeCloseTo(100 * 1.2 ** 10, 6);
    // ファイルにも書かれている
    const saved = await new ModelStore(dir).readVersioned("pop");
    expect(saved.version).toBe(body.model.version);
    expect(saved.model.elements.find((e) => e.name === "Population")!.display!.coordinates).toEqual([300, 200]);
  });

  test("版が違えば書き込まず、最新を返す（AI などが先に変えた場合）", async () => {
    const before = (await get<ModelResponse>("/api/models/pop")).body;
    // AI が先に書き換える
    const m = population();
    m.elements.find((e) => e.name === "Rate")!.behavior!.value = 0.5;
    await new ModelStore(dir).write("pop", m);
    const { status, body } = await post<EditErrorResponse>("/api/models/pop/edit", { version: before.version, elements: [{ name: "Rate", behavior: { value: 0.2 } }] });
    expect(status).toBe(409);
    expect(body.conflict).toBe(true);
    expect(body.current!.model.elements.find((e) => e.name === "Rate")!.behavior!.value).toBe(0.5);
    expect((await new ModelStore(dir).read("pop")).elements.find((e) => e.name === "Rate")!.behavior!.value).toBe(0.5);
  });

  test("元に戻す。戻すと版も元に戻る", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Rate", behavior: { value: 0.2 } }] });
    const e2 = await post<EditResponse>("/api/models/pop/edit", { version: e1.body.model.version, elements: [{ name: "Rate", behavior: { value: 0.3 } }] });
    expect(e2.body.model.undo_available).toBe(2);
    const u1 = await post<EditResponse>("/api/models/pop/undo", { version: e2.body.model.version });
    expect(u1.status).toBe(200);
    expect(u1.body.model.version).toBe(e1.body.model.version);
    const u2 = await post<EditResponse>("/api/models/pop/undo", { version: u1.body.model.version });
    expect(u2.body.model.version).toBe(v0);
    expect(u2.body.model.undo_available).toBe(0);
    expect((await post<EditErrorResponse>("/api/models/pop/undo", { version: v0 })).status).toBe(400);
  });

  test("画面で変えたあとに AI が変えていたら、元に戻さない", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Rate", behavior: { value: 0.2 } }] });
    const m = await new ModelStore(dir).read("pop");
    m.elements.find((e) => e.name === "Rate")!.behavior!.value = 0.5;
    await new ModelStore(dir).write("pop", m);
    const latest = (await get<ModelResponse>("/api/models/pop")).body;
    const { status, body } = await post<EditErrorResponse>("/api/models/pop/undo", { version: latest.version });
    expect(status).toBe(409);
    expect(body.current!.undo_available).toBe(0);
    expect((await new ModelStore(dir).read("pop")).elements.find((e) => e.name === "Rate")!.behavior!.value).toBe(0.5);
  });

  test("編集の誤りは 400 で、ファイルは変えない", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const { status, body } = await post<EditErrorResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Rat", behavior: { value: 1 } }] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Rate/);
    expect((await new ModelStore(dir).readVersioned("pop")).version).toBe(v0);
  });

  test("ほかのサイトからの書き込みは断る", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const edit = { version: v0, elements: [{ name: "Rate", behavior: { value: 9 } }] };
    expect((await post("/api/models/pop/edit", edit, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/models/pop/edit", edit, { "X-IM-Viewer": "" })).status).toBe(403);
    expect((await post("/api/models/pop/edit", edit, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await get("/api/models/pop/edit")).status).toBe(405);
    expect((await new ModelStore(dir).readVersioned("pop")).version).toBe(v0);
  });

  test("要素の変更でないものや、大きすぎる本文は断る", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    expect((await post("/api/models/pop/edit", { version: v0, elements: [null] })).status).toBe(400);
    const big = { version: v0, elements: [{ name: "Rate", description: "x".repeat(1024 * 1024 + 10) }] };
    expect((await post("/api/models/pop/edit", big)).status).toBe(413);
    expect((await new ModelStore(dir).readVersioned("pop")).version).toBe(v0);
  });

  test("foo と foo.json は同じモデルとして元に戻せる", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ name: "Rate", behavior: { value: 0.2 } }] });
    const u = await post<EditResponse>("/api/models/pop.json/undo", { version: e1.body.model.version });
    expect(u.status).toBe(200);
    expect(u.body.model.version).toBe(v0);
  });
});

describe("ビューアからのシナリオの編集", () => {
  test("シナリオを足し、直し、消す。保存した内容はモデルの scenarios に入り、グラフの実行結果も返す", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const add = await post<EditResponse>("/api/models/pop/scenarios", {
      version: v0,
      scenarios: [{ name: "高い", description: "増える割合を上げる", values: { rate: 0.2 } }],
    });
    expect(add.status).toBe(200);
    expect(add.body.report).toMatchObject({ added: ["高い"] });
    // 値の名前は要素の表記にそろえる
    expect(add.body.model.model.scenarios).toEqual([{ name: "高い", description: "増える割合を上げる", values: { Rate: 0.2 } }]);
    expect(add.body.model.scenarios![0]!.series!.Population!.at(-1)).toBeCloseTo(100 * 1.2 ** 10, 6);
    expect(add.body.model.undo_available).toBe(1);

    const fix = await post<EditResponse>("/api/models/pop/scenarios", {
      version: add.body.model.version,
      scenarios: [{ name: "高い", description: null, values: { Rate: null, Population: 200 } }],
    });
    expect(fix.status).toBe(200);
    expect(fix.body.model.model.scenarios).toEqual([{ name: "高い", values: { Population: 200 } }]);

    const remove = await post<EditResponse>("/api/models/pop/scenarios", { version: fix.body.model.version, scenarios: [], remove: ["高い"] });
    expect(remove.status).toBe(200);
    expect(remove.body.report).toMatchObject({ removed: ["高い"] });
    expect(remove.body.model.scenarios).toBeUndefined();
    expect((await new ModelStore(dir).read("pop")).scenarios).toBeUndefined();
    expect(remove.body.model.undo_available).toBe(3);
  });

  test("シナリオの変更も元に戻せる", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const add = await post<EditResponse>("/api/models/pop/scenarios", { version: v0, scenarios: [{ name: "高い", values: { Rate: 0.2 } }] });
    const u = await post<EditResponse>("/api/models/pop/undo", { version: add.body.model.version });
    expect(u.status).toBe(200);
    expect(u.body.model.version).toBe(v0);
    expect(u.body.model.model.scenarios).toBeUndefined();
  });

  test("表のマスで値を 1 つ直す・空にして変えないことにする。どちらも 1 回の「元に戻す」で直す前に戻る", async () => {
    const store = new ModelStore(dir);
    const m = population();
    m.scenarios = [{ name: "高い", values: { Rate: 0.2 } }];
    await store.write("pop", m);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body;
    const fix = await post<EditResponse>("/api/models/pop/scenarios", { version: v0.version, scenarios: [cellPatchOf(v0.model, "高い", "Population", "200")] });
    expect(fix.status).toBe(200);
    expect(fix.body.model.model.scenarios).toEqual([{ name: "高い", values: { Rate: 0.2, Population: 200 } }]);
    expect(fix.body.model.scenarios![0]!.series!.Population![0]).toBe(200);
    const u1 = await post<EditResponse>("/api/models/pop/undo", { version: fix.body.model.version });
    expect(u1.body.model.version).toBe(v0.version);
    expect(u1.body.model.model.scenarios).toEqual([{ name: "高い", values: { Rate: 0.2 } }]);

    const clear = await post<EditResponse>("/api/models/pop/scenarios", { version: v0.version, scenarios: [cellPatchOf(v0.model, "高い", "Rate", "")] });
    expect(clear.body.model.model.scenarios).toEqual([{ name: "高い", values: {} }]);
    const u2 = await post<EditResponse>("/api/models/pop/undo", { version: clear.body.model.version });
    expect(u2.body.model.model.scenarios).toEqual([{ name: "高い", values: { Rate: 0.2 } }]);
  });

  test("表の見出しで、値を変えないシナリオを足す・複製する。表とグラフの列になり、どちらも 1 回の「元に戻す」で足す前に戻る", async () => {
    const store = new ModelStore(dir);
    const m = population();
    m.scenarios = [{ name: "高い", description: "増える割合を上げる", values: { Rate: 0.2 } }];
    await store.write("pop", m);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body;

    const add = await post<EditResponse>("/api/models/pop/scenarios", { version: v0.version, scenarios: [newScenarioPatchOf(v0.model, "広告を増やす")] });
    expect(add.status).toBe(200);
    expect(add.body.model.model.scenarios).toEqual([m.scenarios[0], { name: "広告を増やす", values: {} }]);
    // 値を変えないシナリオも実行し、「元のモデル」と同じ結果を返す（グラフと表の列になる）
    expect(add.body.model.scenarios!.map((s) => s.name)).toEqual(["高い", "広告を増やす"]);
    expect(add.body.model.scenarios![1]!.series).toEqual(add.body.model.run!.series);
    const u1 = await post<EditResponse>("/api/models/pop/undo", { version: add.body.model.version });
    expect(u1.body.model.version).toBe(v0.version);
    expect(u1.body.model.model.scenarios).toEqual(m.scenarios);

    const copy = await post<EditResponse>("/api/models/pop/scenarios", { version: v0.version, scenarios: [newScenarioPatchOf(v0.model, "高い（2）", "高い")] });
    expect(copy.status).toBe(200);
    expect(copy.body.model.model.scenarios![1]).toEqual({ name: "高い（2）", description: "増える割合を上げる", values: { Rate: 0.2 } });
    expect(copy.body.model.scenarios![1]!.series).toEqual(copy.body.model.scenarios![0]!.series);
    const u2 = await post<EditResponse>("/api/models/pop/undo", { version: copy.body.model.version });
    expect(u2.body.model.version).toBe(v0.version);
    expect(u2.body.model.model.scenarios).toEqual(m.scenarios);
  });

  test("表の行を消す（すべてのシナリオでその値を変えない）は、複数のシナリオをまとめた 1 回の保存で、1 回の「元に戻す」で全部戻る", async () => {
    const store = new ModelStore(dir);
    const m = population();
    m.scenarios = [
      { name: "高い", values: { Rate: 0.2, Population: 200 } },
      { name: "低い", values: { rate: 0.05 } },
      { name: "多い", values: { Population: 300 } },
    ];
    await store.write("pop", m);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body;
    const patches = clearValuePatches(v0.model, "Rate");
    // Rate を変えていない「多い」には送らない
    expect(patches.map((p) => p.name)).toEqual(["高い", "低い"]);

    const removed = await post<EditResponse>("/api/models/pop/scenarios", { version: v0.version, scenarios: patches });
    expect(removed.status).toBe(200);
    expect(removed.body.model.model.scenarios).toEqual([
      { name: "高い", values: { Population: 200 } },
      { name: "低い", values: {} },
      { name: "多い", values: { Population: 300 } },
    ]);
    expect(removed.body.model.undo_available).toBe(1);
    const u = await post<EditResponse>("/api/models/pop/undo", { version: removed.body.model.version });
    expect(u.body.model.version).toBe(v0.version);
    expect(u.body.model.model.scenarios).toEqual(m.scenarios);
  });

  test("表の行を消すとき、名前のないシナリオ（scenario N）や表記の違う名前（rate）にも当たる", async () => {
    const store = new ModelStore(dir);
    const m = population();
    m.scenarios = [{ name: "高い", values: { Population: 200 } }, { values: { rate: 0.3, Population: 50 } }];
    await store.write("pop", m);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body;
    const patches = clearValuePatches(v0.model, "Rate");
    expect(patches).toEqual([{ name: "scenario 2", values: { rate: null } }]);
    const removed = await post<EditResponse>("/api/models/pop/scenarios", { version: v0.version, scenarios: patches });
    expect(removed.status).toBe(200);
    expect(removed.body.model.model.scenarios).toEqual([{ name: "高い", values: { Population: 200 } }, { values: { Population: 50 } }]);
  });

  test("シナリオの名前を変えると筋書きの中も直し、元に戻すと筋書きも戻す", async () => {
    const store = new ModelStore(dir);
    const m = population();
    m.scenarios = [{ name: "支援", values: { Rate: 0.2 } }];
    await store.write("pop", m);
    await store.writeSlides("pop", { slides: [{ kind: "solution", title: "解決案", message: "支援する", scenario: "支援" }] });
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const e1 = await post<EditResponse>("/api/models/pop/scenarios", { version: v0, scenarios: [{ name: "支援", rename_to: "手厚い支援" }] });
    expect(e1.status).toBe(200);
    expect(e1.body.report!.notes.join("\n")).toMatch(/pop\.slides\.json/);
    expect(e1.body.model.slides!.deck!.slides[0]).toMatchObject({ scenario: "手厚い支援" });
    expect(e1.body.model.model.scenarios![0]!.name).toBe("手厚い支援");
    const u = await post<EditResponse>("/api/models/pop/undo", { version: e1.body.model.version });
    expect(u.body.model.model.scenarios![0]!.name).toBe("支援");
    expect(u.body.model.slides!.deck!.slides[0]).toMatchObject({ scenario: "支援" });
  });

  test("版が違えば書き込まず、最新を返す（AI などが先にシナリオを変えた場合）", async () => {
    const before = (await get<ModelResponse>("/api/models/pop")).body;
    const m = population();
    m.scenarios = [{ name: "AI のシナリオ", values: { Rate: 0.3 } }];
    await new ModelStore(dir).write("pop", m);
    const { status, body } = await post<EditErrorResponse>("/api/models/pop/scenarios", { version: before.version, scenarios: [{ name: "高い", values: { Rate: 0.2 } }] });
    expect(status).toBe(409);
    expect(body.conflict).toBe(true);
    expect(body.current!.model.scenarios).toEqual([{ name: "AI のシナリオ", values: { Rate: 0.3 } }]);
    expect((await new ModelStore(dir).read("pop")).scenarios).toEqual([{ name: "AI のシナリオ", values: { Rate: 0.3 } }]);
  });

  test("シナリオの誤り（名前の重なり、「元のモデル」、値を変えられない要素など）は 400 で、ファイルは変えない", async () => {
    const store = new ModelStore(dir);
    const m = population();
    m.scenarios = [{ name: "高い", values: { Rate: 0.2 } }];
    await store.write("pop", m);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const bad = async (body: unknown) => (await post<EditErrorResponse>("/api/models/pop/scenarios", { version: v0, ...(body as object) })).body.error;
    expect(await bad({ scenarios: [{ name: "低い" }, { name: "低い", rename_to: "高い" }] })).toMatch(/すでにあります/);
    expect(await bad({ scenarios: [{ name: "元のモデル", values: { Rate: 0 } }] })).toMatch(/何も変えない実行/);
    expect(await bad({ scenarios: [{ name: "低い", values: { Rat: 0 } }] })).toMatch(/Rate/);
    expect(await bad({ scenarios: [], remove: ["ないシナリオ"] })).toMatch(/見つかりません/);
    // 形の誤り
    expect((await post("/api/models/pop/scenarios", { version: v0 })).status).toBe(400);
    expect((await post("/api/models/pop/scenarios", { version: v0, scenarios: [] })).status).toBe(400);
    expect((await post("/api/models/pop/scenarios", { version: v0, scenarios: [{ values: {} }] })).status).toBe(400);
    expect((await post("/api/models/pop/scenarios", { version: v0, scenarios: [], remove: "高い" })).status).toBe(400);
    expect((await post("/api/models/pop/scenarios", { version: v0, scenarios: [{ name: "x" }] }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await store.readVersioned("pop")).version).toBe(v0);
    expect((await get<ModelResponse>("/api/models/pop")).body.undo_available).toBe(0);
  });
});

describe("ビューアからの要素の削除", () => {
  test("要素とつながるリンクを消して保存し、知らせを返す。元に戻すと戻る", async () => {
    const m = population();
    m.scenarios = [{ name: "高い", values: { Rate: 0.2 } }];
    await new ModelStore(dir).write("pop", m);
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const { status, body } = await post<EditResponse>("/api/models/pop/remove", { version: v0, elements: [{ name: "Rate" }] });
    expect(status).toBe(200);
    expect(body.report!.removed).toEqual(['VARIABLE "Rate"', "LINK Rate → Births"]);
    // 式に残った参照と、シナリオから消した値を知らせる
    expect(body.report!.notes.join("\n")).toMatch(/\[Rate\]/);
    expect(body.report!.notes).toContain('シナリオ "高い" から "Rate" の値を消しました。');
    expect(body.model.undo_available).toBe(1);
    const saved = await new ModelStore(dir).read("pop");
    expect(saved.elements.some((e) => e.name === "Rate" || e.from === "Rate")).toBe(false);
    const u = await post<EditResponse>("/api/models/pop/undo", { version: body.model.version });
    expect(u.body.model.version).toBe(v0);
    expect((await new ModelStore(dir).read("pop")).elements.some((e) => e.name === "Rate")).toBe(true);
  });

  test("ストックを消すと、つながるフローは残し、端の雲を消したストックのあった場所に置く", async () => {
    const m = population();
    upsertElements(m, [
      { name: "Population", display: { coordinates: [300, 100] } },
      { name: "Rate", display: { coordinates: [100, 200] } },
      { name: "Births", display: { from_coordinates: [100, 120] } },
    ]);
    await new ModelStore(dir).write("pop", m);
    const box = toGraph(m).nodes.find((n) => n.element === "Population" && n.kind === "STOCK")!;
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const { status, body } = await post<EditResponse>("/api/models/pop/remove", { version: v0, elements: [{ name: "Population" }] });
    expect(status).toBe(200);
    const births = (await new ModelStore(dir).read("pop")).elements.find((e) => e.name === "Births")!;
    expect(births.to).toBeNull();
    expect(births.display!.to_coordinates).toEqual([Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)]);
    expect(births.display!.from_coordinates).toEqual([100, 120]);
    // 雲の座標があるので、図は仮の並べ方にならない
    expect(toGraph(body.model.model).missingCoordinates).toBe(false);
  });

  test("出入りするフローの雲が同じ場所に来るときは、それぞれのフローの向きに沿ってずらす", async () => {
    const m = population();
    upsertElements(m, [
      { name: "Population", display: { coordinates: [300, 100] } },
      { name: "Rate", display: { coordinates: [100, 200] } },
      { name: "Births", display: { from_coordinates: [100, 120] } },
      { type: "FLOW", name: "Deaths", from: "Population", behavior: { value: 1 }, display: { to_coordinates: [600, 120] } },
    ]);
    await new ModelStore(dir).write("pop", m);
    const box = toGraph(m).nodes.find((n) => n.element === "Population" && n.kind === "STOCK")!;
    const center = [box.x + box.width / 2, box.y + box.height / 2] as const;
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    expect((await post("/api/models/pop/remove", { version: v0, elements: [{ name: "Population" }] })).status).toBe(200);
    const saved = await new ModelStore(dir).read("pop");
    const into = saved.elements.find((e) => e.name === "Births")!.display!.to_coordinates!;
    const out = saved.elements.find((e) => e.name === "Deaths")!.display!.from_coordinates!;
    // 入ってくるフローの雲は出元の側（左）へ、出ていくフローの雲は行き先の側（右）へ
    expect(into[0]).toBeLessThan(center[0] - 30);
    expect(out[0]).toBeGreaterThan(center[0] + 30);
    expect(Math.abs(into[1] - center[1])).toBeLessThan(10);
  });

  test("画面で引いたリンク（編集で LINK を足す）を保存し、from と to で消せる。元に戻すと戻る", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const added = await post<EditResponse>("/api/models/pop/edit", { version: v0, elements: [{ type: "LINK", from: "Population", to: "Rate" }] });
    expect(added.status).toBe(200);
    expect(added.body.report!.added).toEqual(["LINK Population → Rate"]);
    const isLink = (e: { type: string; from?: string | null; to?: string | null }) => e.type === "LINK" && e.from === "Population" && e.to === "Rate";
    expect((await new ModelStore(dir).read("pop")).elements.some(isLink)).toBe(true);
    const removed = await post<EditResponse>("/api/models/pop/remove", { version: added.body.model.version, elements: [{ from: "Population", to: "Rate" }] });
    expect(removed.status).toBe(200);
    expect(removed.body.report!.removed).toEqual(["LINK Population → Rate"]);
    expect((await new ModelStore(dir).read("pop")).elements.some(isLink)).toBe(false);
    // 消したリンクを元に戻し、もう一度戻すと引く前に戻る
    const u1 = await post<EditResponse>("/api/models/pop/undo", { version: removed.body.model.version });
    expect(u1.body.model.model.elements.some(isLink)).toBe(true);
    const u2 = await post<EditResponse>("/api/models/pop/undo", { version: u1.body.model.version });
    expect(u2.body.model.version).toBe(v0);
  });

  test("ない要素や、要素の指定でないものは 400 で、ファイルは変えない。版が違えば書き込まない", async () => {
    const v0 = (await get<ModelResponse>("/api/models/pop")).body.version;
    const missing = await post<EditErrorResponse>("/api/models/pop/remove", { version: v0, elements: [{ name: "Rat" }] });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Rate/);
    expect((await post("/api/models/pop/remove", { version: v0, elements: [] })).status).toBe(400);
    expect((await post("/api/models/pop/remove", { version: v0, elements: [{ type: "STOCK" }] })).status).toBe(400);
    expect((await post("/api/models/pop/remove", { version: v0, elements: [{ name: "Rate" }] }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post<EditErrorResponse>("/api/models/pop/remove", { version: "old", elements: [{ name: "Rate" }] })).status).toBe(409);
    expect((await new ModelStore(dir).readVersioned("pop")).version).toBe(v0);
  });
});

describe("作業フォルダがまだないとき", () => {
  test("作ってから見張るので、あとからできたモデルにも気づく", async () => {
    const parent = await tempDir();
    const missing = path.join(parent, "not-yet");
    const v = await startViewer({ modelsDir: missing, port: 0 });
    try {
      const controller = new AbortController();
      const res = await fetch(new URL("/api/events", v.url), { signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const received = (async () => {
        let text = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) throw new Error("イベントが届く前に切れた");
          text += decoder.decode(value);
          const m = text.match(/data: (.*)\n\n/);
          if (m) return JSON.parse(m[1]!) as ChangeEvent;
        }
      })();
      await new Promise((r) => setTimeout(r, 100));
      await new ModelStore(missing).write("later", population());
      expect(await received).toEqual({ type: "changed", name: "later" });
      controller.abort();
    } finally {
      await v.close();
    }
  });
});

