import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelStore, emptyModel } from "../src/core/index.js";
import type { DiagramExportResponse } from "../src/viewer/api.js";
import { checkFileBase, exportFolderOf } from "../src/viewer/diagram-export.js";
import { startViewer, type Viewer } from "../src/viewer/server.js";
import { svgFontFamily } from "../web/src/diagramExport.js";
import { tempDir } from "./helpers.js";

let dir: string;
let viewer: Viewer;

/** 1 × 1 の PNG（画面が送る PNG の代わり） */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text x="0" y="8">人口</text></svg>';

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
  const store = new ModelStore(dir);
  await store.write("pop", emptyModel("人口モデル"));
  await store.write("事例/在庫", emptyModel("在庫"));
  viewer = await startViewer({ modelsDir: dir, port: 0 });
});

afterEach(async () => {
  await viewer.close();
});

describe("図の書き出し（SVG と PNG）", () => {
  test("書き出し先は exports/<モデル名>。ファイル名にフォルダの区切りは使えない", () => {
    expect(exportFolderOf("pop")).toBe(path.join("exports", "pop"));
    expect(exportFolderOf("事例/在庫")).toBe(path.join("exports", "事例", "在庫"));
    expect(checkFileBase("diagram")).toBe("diagram");
    expect(checkFileBase("ループ R1.svg")).toBe("ループ R1");
    expect(() => checkFileBase("../x")).toThrow(/使えません/);
    expect(() => checkFileBase("")).toThrow(/使えません/);
  });

  test("SVG のフォントは、総称の名前を除いた具体的なフォントを先に並べ、日本語のフォントを足して、最後に sans-serif を 1 つだけ置く", () => {
    const family = svgFontFamily(`system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif`);
    expect(family).toBe("'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', Meiryo, 'Yu Gothic', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Noto Sans CJK JP', sans-serif");
    expect(svgFontFamily("ui-monospace, Consolas, monospace")).toMatch(/^Consolas, 'Segoe UI'.*, sans-serif$/);
  });

  test("ビューアの「書き出す」で送った画像を、exports/<モデル名>/diagram.svg と diagram.png に書く", async () => {
    const res = await post<DiagramExportResponse>("/api/models/pop/export-diagram", { svg: SVG, png: PNG });
    expect(res.status).toBe(200);
    const folder = path.join(dir, "exports", "pop");
    expect(res.body).toEqual({ dir: folder, files: [path.join(folder, "diagram.svg"), path.join(folder, "diagram.png")] });
    expect(await readFile(path.join(folder, "diagram.svg"), "utf8")).toBe(SVG);
    expect((await readFile(path.join(folder, "diagram.png"))).equals(Buffer.from(PNG, "base64"))).toBe(true);

    // フォルダにあるモデルは exports/<フォルダ>/<名前>/。もう一度書き出すと置き換える
    const nested = await post<DiagramExportResponse>(`/api/models/${encodeURIComponent("事例/在庫")}/export-diagram`, { svg: SVG, png: PNG });
    expect(nested.body.dir).toBe(path.join(dir, "exports", "事例", "在庫"));
    expect((await post("/api/models/pop/export-diagram", { svg: SVG.replace("人口", "人"), png: PNG })).status).toBe(200);
    expect(await readFile(path.join(folder, "diagram.svg"), "utf8")).toMatch(/>人</);
    expect((await readdir(folder)).sort()).toEqual(["diagram.png", "diagram.svg"]);
  });

  test("ほかのサイトからの書き出し、画像でないもの、ないモデルは断る", async () => {
    expect((await post("/api/models/pop/export-diagram", { svg: SVG, png: PNG }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/models/pop/export-diagram", { svg: SVG, png: PNG }, { "X-IM-Viewer": "" })).status).toBe(403);
    expect((await post("/api/models/pop/export-diagram", { svg: "<html/>", png: PNG })).status).toBe(400);
    expect((await post("/api/models/pop/export-diagram", { svg: SVG, png: Buffer.from("not png").toString("base64") })).status).toBe(400);
    expect((await post("/api/models/nothing/export-diagram", { svg: SVG, png: PNG })).status).toBe(404);
    expect(await readdir(dir)).not.toContain("exports");
  });
});
