import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import {
  boxLayout,
  checkDiagram,
  EditError,
  EMPHASIS_SCALE,
  emptyModel,
  layoutModel,
  ModelStore,
  runModel,
  summarizeModel,
  toGraph,
  upsertElements,
  validateModel,
  type ModelJSON,
} from "../src/core/index.js";
import type { EditResponse, ModelResponse } from "../src/viewer/api.js";
import { startViewer, type Viewer } from "../src/viewer/server.js";
import { tempDir } from "./helpers.js";

// 図の要素の強調（display.emphasis）

function population(): ModelJSON {
  const m = emptyModel("population");
  upsertElements(m, [
    { type: "STOCK", name: "Population", behavior: { initial_value: 1000 } },
    { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
    { type: "FLOW", name: "Births", from: null, to: "Population", behavior: { value: "[Population]*[Birth Rate]" } },
  ]);
  return m;
}

const nodeOf = (m: ModelJSON, name: string) => toGraph(m).nodes.find((n) => n.element === name && n.kind !== "VALVE")!;

describe("箱の大きさ", () => {
  test("強調すると、箱を EMPHASIS_SCALE 倍にする。名前の行の分け方は変えない", () => {
    const name = "管理者が考える必要な人数";
    const plain = boxLayout("STOCK", name);
    const big = boxLayout("STOCK", name, undefined, true);
    expect(big.size).toEqual([Math.ceil(plain.size[0] * EMPHASIS_SCALE), Math.ceil(plain.size[1] * EMPHASIS_SCALE)]);
    expect(big.lines).toEqual(plain.lines);
  });

  test("display.size を指定した要素は、その大きさを基準に大きくする", () => {
    expect(boxLayout("VARIABLE", "Rate", [200, 100], true).size).toEqual([280, 140]);
  });
});

describe("図への変換と確認", () => {
  test("強調した要素は、図のノードを大きくして印を付ける。ほかはそのまま", () => {
    const m = population();
    layoutModel(m);
    const before = nodeOf(m, "Population");
    upsertElements(m, [{ name: "Population", display: { emphasis: true } }]);
    const after = nodeOf(m, "Population");
    expect(after.emphasis).toBe(true);
    expect([after.width, after.height]).toEqual(boxLayout("STOCK", "Population", undefined, true).size);
    expect(after.width).toBeGreaterThan(before.width);
    expect(nodeOf(m, "Birth Rate").emphasis).toBeUndefined();
  });

  test("重なりの確認は、強調で大きくなった箱の大きさを使う", () => {
    const m = emptyModel("m");
    upsertElements(m, [
      { type: "STOCK", name: "A", behavior: { initial_value: 1 }, display: { coordinates: [100, 100] } },
      // ふつうの A（幅 100）の右に、少しすき間をあけて置く
      { type: "STOCK", name: "B", behavior: { initial_value: 1 }, display: { coordinates: [220, 100] } },
    ]);
    expect(checkDiagram(m).overlaps).toEqual([]);
    upsertElements(m, [{ name: "A", display: { emphasis: true, coordinates: [100, 100] } }]);
    const check = checkDiagram(m);
    expect(check.overlaps).toEqual(["A と B"]);
    expect(check.positions.find((p) => p.name === "A")).toMatchObject({ emphasis: true, size: boxLayout("STOCK", "A", undefined, true).size });
    expect(check.positions.find((p) => p.name === "B")!.emphasis).toBeUndefined();
  });

  test("簡易レイアウト（layout_model）は、強調で大きくなった箱が重ならないように並べる", () => {
    const m = emptyModel("m");
    const names = ["在庫", "注文", "出荷", "生産"];
    upsertElements(
      m,
      names.map((name) => ({ type: "STOCK" as const, name, behavior: { initial_value: 1 }, display: { emphasis: true } })),
    );
    upsertElements(m, [{ type: "VARIABLE", name: "目標", behavior: { value: 1 }, display: { emphasis: true } }]);
    layoutModel(m);
    expect(checkDiagram(m).overlaps).toEqual([]);
  });
});

describe("強調の付け外し（upsert_elements）", () => {
  test("true で付け、false で消す（ふつうの要素には何も書かない）。シミュレーションは変わらない", () => {
    const m = population();
    const plainRun = runModel(m);
    upsertElements(m, [{ name: "Population", display: { emphasis: true } }]);
    expect(m.elements.find((e) => e.name === "Population")!.display).toEqual({ emphasis: true });
    // エンジンは知らない display の項目をエラーにするので、取り除いて渡している（モデルそのものは変えない）
    expect(runModel(m)).toEqual(plainRun);
    expect(validateModel(m).ok).toBe(true);
    expect(m.elements.find((e) => e.name === "Population")!.display).toEqual({ emphasis: true });
    upsertElements(m, [{ name: "Population", display: { emphasis: false } }]);
    expect(m.elements.find((e) => e.name === "Population")!.display).toBeUndefined();
  });

  test("付け外ししても、箱の真ん中の位置は変えない。座標も一緒に指定したときはそれに従う", () => {
    const m = population();
    upsertElements(m, [{ name: "Population", display: { coordinates: [300, 200] } }]);
    const center = (name: string) => {
      const n = nodeOf(m, name);
      return [n.x + n.width / 2, n.y + n.height / 2];
    };
    const c0 = center("Population");
    upsertElements(m, [{ name: "Population", display: { emphasis: true } }]);
    const c1 = center("Population");
    expect(Math.abs(c1[0]! - c0[0]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(c1[1]! - c0[1]!)).toBeLessThanOrEqual(1);
    upsertElements(m, [{ name: "Population", display: { emphasis: null } }]);
    expect(m.elements.find((e) => e.name === "Population")!.display!.coordinates).toEqual([300, 200]);
    upsertElements(m, [{ name: "Population", display: { emphasis: true, coordinates: [10, 20] } }]);
    expect(m.elements.find((e) => e.name === "Population")!.display!.coordinates).toEqual([10, 20]);
  });

  test("大きさの差が奇数でも、付けて外すのを繰り返すと元の座標に戻る", () => {
    const m = emptyModel("m");
    const name = "Desired Inventory Coverage X";
    upsertElements(m, [{ type: "STOCK", name, behavior: { initial_value: 1 }, display: { coordinates: [300, 200] } }]);
    for (let i = 0; i < 5; i++) {
      upsertElements(m, [{ name, display: { emphasis: true } }]);
      upsertElements(m, [{ name, display: { emphasis: false } }]);
      expect(m.elements[0]!.display!.coordinates).toEqual([300, 200]);
    }
  });

  test("箱にならない要素（フローやリンク）と、true / false 以外の値はエラーにする", () => {
    const m = population();
    expect(() => upsertElements(m, [{ name: "Births", display: { emphasis: true } }])).toThrow(EditError);
    expect(() => upsertElements(m, [{ name: "Births", display: { emphasis: true } }])).toThrow(/強調できるのは/);
    expect(() => upsertElements(m, [{ from: "Birth Rate", to: "Births", display: { emphasis: true } }])).toThrow(/強調できるのは/);
    expect(() => upsertElements(m, [{ name: "Population", display: { emphasis: "yes" } }])).toThrow(/true（強調）か false（ふつう）/);
    // ふつうに戻すのは、どの要素でもエラーにしない
    upsertElements(m, [{ name: "Births", display: { emphasis: false } }]);
  });

  test("モデルの要約（get_model）に、強調した要素を出す", () => {
    const m = population();
    upsertElements(m, [{ name: "Birth Rate", display: { emphasis: true } }]);
    const s = summarizeModel(m);
    expect(s.variables[0]).toMatchObject({ name: "Birth Rate", emphasis: true });
    expect(s.stocks[0]!.emphasis).toBeUndefined();
  });
});

describe("MCP から強調する", () => {
  let client: Client;
  beforeEach(async () => {
    const server = createServer({ modelsDir: await tempDir() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]!.text;
    return { isError: !!res.isError, text, json: res.isError ? undefined : JSON.parse(text) };
  };

  test("upsert_elements で付け、layout_model と view_diagram の確認は大きくなった箱の大きさを使う", async () => {
    await call("create_model", { model: "pop" });
    await call("upsert_elements", {
      model: "pop",
      elements: [
        { type: "STOCK", name: "Population", behavior: { initial_value: 1000 }, display: { emphasis: true } },
        { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
        { type: "FLOW", name: "Births", from: null, to: "Population", behavior: { value: "[Population]*[Birth Rate]" } },
      ],
    });
    const laid = await call("layout_model", { model: "pop" });
    expect(laid.json.diagram.overlaps).toEqual([]);
    const view = await call("view_diagram", { model: "pop", image: false });
    expect(view.json.positions.find((p: { name: string }) => p.name === "Population")).toMatchObject({
      emphasis: true,
      size: boxLayout("STOCK", "Population", undefined, true).size,
    });
    const summary = await call("get_model", { model: "pop" });
    expect(summary.json.stocks[0]).toMatchObject({ name: "Population", emphasis: true });
    const bad = await call("upsert_elements", { model: "pop", elements: [{ name: "Births", display: { emphasis: true } }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/強調できるのは/);
  });
});

describe("ビューアの詳細欄から強調する", () => {
  let dir: string;
  let viewer: Viewer;
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

  test("詳細欄と同じ変更（{ name, display: { emphasis } }）を送ると、付け外しを保存する", async () => {
    const edit = async (version: string, emphasis: boolean) => {
      const res = await fetch(new URL("/api/models/pop/edit", viewer.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-IM-Viewer": "1", Origin: viewer.url.replace(/\/$/, "") },
        body: JSON.stringify({ version, elements: [{ name: "Population", display: { emphasis } }] }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as EditResponse;
    };
    const v0 = ((await (await fetch(new URL("/api/models/pop", viewer.url))).json()) as ModelResponse).version;
    const on = await edit(v0, true);
    expect(on.model.model.elements.find((e) => e.name === "Population")!.display).toEqual({ emphasis: true });
    const off = await edit(on.model.version, false);
    expect(off.model.model.elements.find((e) => e.name === "Population")!.display).toBeUndefined();
  });
});
