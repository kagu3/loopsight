import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelStore, emptyModel, upsertElements } from "../src/core/index.js";
import type { ChangeEvent, EditErrorResponse, EditResponse, ModelListResponse, ModelResponse } from "../src/viewer/api.js";
import { startViewer, type Viewer } from "../src/viewer/server.js";
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
});
