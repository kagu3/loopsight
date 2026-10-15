import { describe, expect, test } from "vitest";
import { emptyModel, layoutModel, upsertElements, type ModelJSON } from "../src/core/index.js";
import { borderPoint, toGraph, type GraphNode } from "../web/src/graph.js";
import { loadSample, sampleNames } from "./helpers.js";

function population(): ModelJSON {
  const m = emptyModel("population");
  upsertElements(m, [
    { type: "STOCK", name: "Population", behavior: { initial_value: 1000 } },
    { type: "VARIABLE", name: "Birth Rate", behavior: { value: 0.03 } },
    { type: "FLOW", name: "Births", from: null, to: "Population", behavior: { value: "[Population]*[Birth Rate]" } },
    { type: "FLOW", name: "Deaths", from: "Population", to: null, behavior: { value: "[Population]*0.01" } },
  ]);
  return m;
}

function overlap(a: GraphNode, b: GraphNode): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("図への変換", () => {
  test("フローは弁と雲を通る 2 本の線にし、リンクは弁につなぐ", () => {
    const g = toGraph(population());
    const kinds = g.nodes.map((n) => n.kind).sort();
    expect(kinds).toEqual(["CLOUD", "CLOUD", "STOCK", "VALVE", "VALVE", "VARIABLE"]);
    const births = g.edges.filter((e) => e.element === "Births");
    expect(births.map((e) => [e.source, e.target, e.arrow])).toEqual([
      ["cloud:births:from", "valve:births", false],
      ["valve:births", "el:population", true],
    ]);
    const link = g.edges.find((e) => e.kind === "link" && e.source === "el:birth rate")!;
    expect(link.target).toBe("valve:births");
  });

  test("座標がなければ自動配置にし、重ならないように並べる", () => {
    const g = toGraph(population());
    expect(g.autoLayout).toBe(true);
    expect(g.missingCoordinates).toBe(true);
    for (let i = 0; i < g.nodes.length; i++) {
      for (let j = i + 1; j < g.nodes.length; j++) {
        expect(overlap(g.nodes[i]!, g.nodes[j]!), `${g.nodes[i]!.id} と ${g.nodes[j]!.id}`).toBe(false);
      }
    }
    // フローの流れは左から右
    const x = (id: string) => g.nodes.find((n) => n.id === id)!.x;
    expect(x("cloud:births:from")).toBeLessThan(x("el:population"));
    expect(x("el:population")).toBeLessThan(x("cloud:deaths:to"));
  });

  test("座標がそろっていればモデルの座標を使い、弁は両端の真ん中に置く", () => {
    const m = population();
    layoutModel(m);
    const g = toGraph(m);
    expect(g.autoLayout).toBe(false);
    const stock = g.nodes.find((n) => n.id === "el:population")!;
    expect([stock.x, stock.y]).toEqual(m.elements.find((e) => e.name === "Population")!.display!.coordinates);
    const cloud = g.nodes.find((n) => n.id === "cloud:births:from")!;
    const valve = g.nodes.find((n) => n.id === "valve:births")!;
    const c = (n: GraphNode) => [n.x + n.width / 2, n.y + n.height / 2];
    expect(c(valve)).toEqual([(c(cloud)[0]! + c(stock)[0]!) / 2, (c(cloud)[1]! + c(stock)[1]!) / 2]);
    // 指定すれば座標があっても自動配置にする
    expect(toGraph(m, { forceAutoLayout: true }).autoLayout).toBe(true);
  });

  test("同梱のサンプルもすべて変換できる", () => {
    for (const name of sampleNames()) {
      const g = toGraph(loadSample(name));
      const ids = new Set(g.nodes.map((n) => n.id));
      for (const e of g.edges) {
        expect(ids.has(e.source) && ids.has(e.target), e.id).toBe(true);
      }
    }
  });

  test("線は箱の縁から出す（楕円と長方形）", () => {
    const rect = { x: 0, y: 0, width: 100, height: 40, shape: "rect" as const };
    expect(borderPoint(rect, 250, 20)).toEqual([100, 20]);
    expect(borderPoint(rect, 50, -100)).toEqual([50, 0]);
    const ellipse = { x: 0, y: 0, width: 120, height: 50, shape: "ellipse" as const };
    const [x, y] = borderPoint(ellipse, 60, 200);
    expect(x).toBeCloseTo(60);
    expect(y).toBeCloseTo(50);
  });
});
