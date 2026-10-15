import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelStore, emptyModel, upsertElements } from "../src/core/index.js";
import type { ChangeEvent, ModelListResponse, ModelResponse } from "../src/viewer/api.js";
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
