import { describe, expect, test } from "vitest";
import { borderPoint, bounds, emptyModel, fitTargets, layoutModel, MIN_FIT_ZOOM, positionPatches, shiftIntoView, toGraph, upsertElements, type GraphNode, type ModelJSON } from "../src/core/index.js";
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

  test("座標がなければ、書き出しと同じ簡易レイアウトで仮に並べ、重ならないようにする", () => {
    const m = population();
    const g = toGraph(m);
    expect(g.missingCoordinates).toBe(true);
    // モデルそのものには座標を書かない
    expect(m.elements.some((e) => e.display?.coordinates)).toBe(false);
    for (let i = 0; i < g.nodes.length; i++) {
      for (let j = i + 1; j < g.nodes.length; j++) {
        expect(overlap(g.nodes[i]!, g.nodes[j]!), `${g.nodes[i]!.id} と ${g.nodes[j]!.id}`).toBe(false);
      }
    }
    // 書き出し（export_model）で付く座標と同じ
    const exported = structuredClone(m);
    layoutModel(exported);
    const stock = g.nodes.find((n) => n.id === "el:population")!;
    expect([stock.x, stock.y]).toEqual(exported.elements.find((e) => e.name === "Population")!.display!.coordinates);
  });

  test("座標がそろっていればモデルの座標を使い、弁は両端の真ん中に置く", () => {
    const m = population();
    layoutModel(m);
    const g = toGraph(m);
    expect(g.missingCoordinates).toBe(false);
    const stock = g.nodes.find((n) => n.id === "el:population")!;
    expect([stock.x, stock.y]).toEqual(m.elements.find((e) => e.name === "Population")!.display!.coordinates);
    const cloud = g.nodes.find((n) => n.id === "cloud:births:from")!;
    const valve = g.nodes.find((n) => n.id === "valve:births")!;
    const c = (n: GraphNode) => [n.x + n.width / 2, n.y + n.height / 2];
    expect(c(valve)).toEqual([(c(cloud)[0]! + c(stock)[0]!) / 2, (c(cloud)[1]! + c(stock)[1]!) / 2]);
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

  test("仮に並べた位置をモデルに保存すると、その位置のまま座標つきで描ける", () => {
    const m = population();
    const auto = toGraph(m);
    expect(auto.missingCoordinates).toBe(true);
    upsertElements(m, positionPatches(auto.nodes));
    const saved = toGraph(m);
    expect(saved.missingCoordinates).toBe(false);
    const pos = (g: typeof auto, id: string) => {
      const n = g.nodes.find((x) => x.id === id)!;
      return [Math.round(n.x), Math.round(n.y)];
    };
    for (const id of ["el:population", "el:birth rate", "cloud:births:from", "cloud:deaths:to"]) {
      expect(pos(saved, id), id).toEqual(pos(auto, id));
    }
  });

  test("動かしたノードだけを保存する形にできる（雲はフローの端の座標になる）", () => {
    const m = population();
    layoutModel(m);
    const g = toGraph(m);
    const cloud = g.nodes.find((n) => n.id === "cloud:births:from")!;
    cloud.x = 40;
    cloud.y = 60;
    expect(positionPatches(g.nodes, new Set(["cloud:births:from"]))).toEqual([{ name: "Births", display: { from_coordinates: [58, 73] } }]);
  });

  test("左や上にはみ出した配置は、全体をずらす", () => {
    const m = population();
    layoutModel(m);
    const g = toGraph(m);
    expect(shiftIntoView(g.nodes)).toBeUndefined();
    const stock = g.nodes.find((n) => n.id === "el:population")!;
    stock.x = -30;
    stock.y = 5;
    const shifted = shiftIntoView(g.nodes)!;
    const s = shifted.find((n) => n.id === "el:population")!;
    expect([s.x, s.y]).toEqual([20, 20]);
    expect(Math.min(...shifted.map((n) => n.x))).toBe(20);
    expect(Math.min(...shifted.map((n) => n.y))).toBe(20);
  });

  test("画面に合わせるとき、下限の倍率で全体が入らなければストックだけを入れる", () => {
    const m = population();
    layoutModel(m);
    const g = toGraph(m);
    const b = bounds(g.nodes);
    // 全体が等倍で入る
    expect(fitTargets(g.nodes, b.width * 2, b.height * 2, 0.15)).toEqual({ nodes: g.nodes, maxZoom: 1.5 });
    // 下限より縮めないと入らない。ストックだけを下限の倍率で見せる（ストックに合わせて拡大しない）
    const small = fitTargets(g.nodes, b.width * 0.5, b.height * 0.5, 0.15);
    expect(small.nodes.map((n) => n.id)).toEqual(["el:population"]);
    expect(small.maxZoom).toBe(MIN_FIT_ZOOM);
    // ストックがなければすべて
    const noStock = g.nodes.filter((n) => n.kind !== "STOCK");
    expect(fitTargets(noStock, 10, 10, 0.15)).toEqual({ nodes: noStock, maxZoom: MIN_FIT_ZOOM });
    // 下限の倍率で入れば全体
    expect(fitTargets(g.nodes, b.width * 1.16 * MIN_FIT_ZOOM, b.height * 1.16 * MIN_FIT_ZOOM, 0.15)).toEqual({ nodes: g.nodes, maxZoom: 1.5 });
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
