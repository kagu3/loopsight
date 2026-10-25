import { describe, expect, test } from "vitest";
import { borderPoint, bounds, boxLayout, checkDiagram, connectedTo, emptyModel, fitTargets, labelLines, layoutModel, loopFocus, MIN_FIT_ZOOM, positionPatches, shiftIntoView, textWidth, toGraph, upsertElements, type GraphNode, type ModelJSON } from "../src/core/index.js";
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

  test("座標がなければ、layout_model と同じ簡易レイアウトで仮に並べ、重ならないようにする", () => {
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
    // layout_model で付く座標と同じ
    const laid = structuredClone(m);
    layoutModel(laid);
    const stock = g.nodes.find((n) => n.id === "el:population")!;
    expect([stock.x, stock.y]).toEqual(laid.elements.find((e) => e.name === "Population")!.display!.coordinates);
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

describe("選んだ要素につながるもの", () => {
  const sorted = (s: Set<string>) => [...s].sort();

  test("フローを選ぶと、その 2 本の線と両端、弁につながるリンクとその相手", () => {
    const g = toGraph(population());
    const c = connectedTo(g, "Births")!;
    expect(sorted(c.nodes)).toEqual(["cloud:births:from", "el:birth rate", "el:population", "valve:births"]);
    expect(sorted(c.edges)).toEqual(["link:el:birth rate->valve:births", "valve:births:in", "valve:births:out"]);
  });

  test("ストックを選ぶと、出入りするフローを最後までたどる（弁につながるほかのリンクは含めない）", () => {
    const g = toGraph(population());
    const c = connectedTo(g, "population")!;
    expect(sorted(c.nodes)).toEqual(["cloud:births:from", "cloud:deaths:to", "el:population", "valve:births", "valve:deaths"]);
    // Birth Rate → Births のリンクと Birth Rate は含めない
    expect(sorted(c.edges)).toEqual(["valve:births:in", "valve:births:out", "valve:deaths:in", "valve:deaths:out"]);
  });

  test("リンクの先が弁なら、弁だけを含め、そのフローの線までは広げない", () => {
    const g = toGraph(population());
    const c = connectedTo(g, "Birth Rate")!;
    expect(sorted(c.nodes)).toEqual(["el:birth rate", "valve:births"]);
    expect(sorted(c.edges)).toEqual(["link:el:birth rate->valve:births"]);
  });

  test("大文字小文字が違う名前でも引ける", () => {
    const g = toGraph(population());
    expect(connectedTo(g, "births")).toEqual(connectedTo(g, "Births"));
  });

  test("弁が出元のリンク（フロー → 変数）は、フローを選べば含め、変数を選べば弁だけにとどめる", () => {
    const m = population();
    upsertElements(m, [{ type: "VARIABLE", name: "Birth Count", behavior: { value: "[Births]" } }]);
    const g = toGraph(m);
    const link = g.edges.find((e) => e.kind === "link" && e.source === "valve:births")!;
    expect(link.target).toBe("el:birth count");
    const flow = connectedTo(g, "Births")!;
    expect(flow.edges.has(link.id)).toBe(true);
    expect(flow.nodes.has("el:birth count")).toBe(true);
    const variable = connectedTo(g, "Birth Count")!;
    expect(sorted(variable.nodes)).toEqual(["el:birth count", "valve:births"]);
    expect(sorted(variable.edges)).toEqual([link.id]);
  });

  test("図にない要素なら何も薄くしない", () => {
    expect(connectedTo(toGraph(population()), "Nothing")).toBeUndefined();
  });
});

describe("ループの要素と線", () => {
  const sorted = (s: Set<string>) => [...s].sort();

  test("ストックとフローのループは、弁とストックのあいだのフローの線だけを含める（雲側の線は含めない）", () => {
    const g = toGraph(population());
    // Births がストックを増やし、Births の式がストックを見ている
    const births = loopFocus(g, ["Population", "Births"])!;
    expect(sorted(births.nodes)).toEqual(["el:population", "valve:births"]);
    expect(sorted(births.edges)).toEqual(["valve:births:out"]);
    // Deaths は出元のストックを減らす。線の向き（ストック → 弁）は問わない
    const deaths = loopFocus(g, ["population", "deaths"])!;
    expect(sorted(deaths.edges)).toEqual(["valve:deaths:in"]);
  });

  test("リンクは並びの向きのものだけを含める", () => {
    const m = population();
    upsertElements(m, [
      { type: "VARIABLE", name: "Crowding", behavior: { value: "[Population] / 1000" } },
      { type: "VARIABLE", name: "Birth Rate", behavior: { value: "0.03 / [Crowding]" } },
    ]);
    const g = toGraph(m);
    const loop = loopFocus(g, ["Population", "Crowding", "Birth Rate", "Births"])!;
    expect(sorted(loop.nodes)).toEqual(["el:birth rate", "el:crowding", "el:population", "valve:births"]);
    expect(sorted(loop.edges)).toEqual([
      "link:el:birth rate->valve:births",
      "link:el:crowding->el:birth rate",
      "link:el:population->el:crowding",
      "valve:births:out",
    ]);
  });

  test("図にない要素だけなら何も薄くしない", () => {
    expect(loopFocus(toGraph(population()), ["Nothing"])).toBeUndefined();
  });
});

describe("箱の幅と名前の行", () => {
  test("短い名前は 1 行で、箱はこれまでの大きさのまま", () => {
    expect(boxLayout("STOCK", "新人")).toEqual({ size: [100, 40], lines: ["新人"], fits: true });
    expect(boxLayout("VARIABLE", "締め切り")).toEqual({ size: [120, 50], lines: ["締め切り"], fits: true });
  });

  test("少し長い名前は 1 行のまま、箱を広げて収める", () => {
    const { size, lines } = boxLayout("STOCK", "プロジェクトの期間");
    expect(lines).toEqual(["プロジェクトの期間"]);
    expect(size[0]).toBeGreaterThan(100);
    expect(size[0]).toBeGreaterThanOrEqual(textWidth("プロジェクトの期間", 13));
  });

  test("とても長い名前は、言葉の切れ目で 2 行に分ける", () => {
    expect(labelLines("管理者が考える必要な人数")).toEqual(["管理者が考える", "必要な人数"]);
    expect(labelLines("1 組あたりの意思疎通の手間")).toEqual(["1 組あたりの", "意思疎通の手間"]);
    expect(labelLines("Average Number of Daily Contacts")).toEqual(["Average Number", "of Daily Contacts"]);
    expect(labelLines("プロジェクトマネージャー　サポート担当")).toEqual(["プロジェクトマネージャー", "サポート担当"]);
    const { size, lines } = boxLayout("VARIABLE", "管理者が考える必要な人数");
    expect(lines).toHaveLength(2);
    expect(size[1]).toBeGreaterThan(50);
  });

  test("分けられるところがない名前は、言葉の途中で分けず 1 行のまま広げる", () => {
    const name = "プロジェクトマネージャー";
    expect(labelLines(name)).toEqual([name]);
    expect(boxLayout("STOCK", name).size[0]).toBeGreaterThanOrEqual(textWidth(name, 13));
  });

  test("モデルに大きさ（display.size）があれば、その大きさにして名前をその幅で分ける", () => {
    expect(boxLayout("STOCK", "管理者が考える必要な人数", [200, 40])).toEqual({ size: [200, 40], lines: ["管理者が考える必要な人数"], fits: true });
    expect(boxLayout("STOCK", "管理者が考える必要な人数", [120, 60])).toEqual({ size: [120, 60], lines: ["管理者が考える", "必要な人数"], fits: true });
  });

  test("決まった大きさに名前が入りきらなければ、画面で折り返すようにする", () => {
    // 2 行にしても高さ 40 のストックには入らない
    expect(boxLayout("STOCK", "管理者が考える必要な人数", [100, 40]).fits).toBe(false);
    // 分けられるところがなく、幅に入らない
    expect(boxLayout("VARIABLE", "プロジェクトマネージャー", [120, 50]).fits).toBe(false);
    expect(boxLayout("STOCK", "新人", [100, 40]).fits).toBe(true);
    const m = emptyModel("fixed");
    upsertElements(m, [
      { type: "STOCK", name: "管理者が考える必要な人数", display: { coordinates: [100, 100], size: [100, 40] } },
      { type: "STOCK", name: "新人", display: { coordinates: [300, 100], size: [100, 40] } },
    ]);
    const nodes = toGraph(m).nodes;
    expect(nodes.find((n) => n.element === "管理者が考える必要な人数")!.wrapLabel).toBe(true);
    expect(nodes.find((n) => n.element === "新人")!.wrapLabel).toBeUndefined();
  });

  test("図、簡易レイアウト、図の確認で、箱の大きさが同じ", () => {
    const m = emptyModel("names");
    upsertElements(m, [
      { type: "STOCK", name: "プロジェクトの期間", behavior: { initial_value: 10 } },
      { type: "VARIABLE", name: "管理者が考える必要な人数", behavior: { value: "[プロジェクトの期間]" } },
      { type: "VARIABLE", name: "標準の生産性", behavior: { value: 1 } },
    ]);
    const sizes = (nodes: GraphNode[]) => Object.fromEntries(nodes.filter((n) => n.element).map((n) => [n.element!, [n.width, n.height]]));
    // 座標のないモデル（仮に並べて描く）
    const auto = sizes(toGraph(m).nodes);
    expect(auto["管理者が考える必要な人数"]).toEqual(boxLayout("VARIABLE", "管理者が考える必要な人数").size);
    expect(toGraph(m).nodes.find((n) => n.element === "管理者が考える必要な人数")!.lines).toEqual(["管理者が考える", "必要な人数"]);
    // 簡易レイアウトで座標を付けたあとの図と、図の確認（view_diagram）が使う大きさも同じ
    layoutModel(m);
    expect(sizes(toGraph(m).nodes)).toEqual(auto);
    const check = checkDiagram(m);
    for (const p of check.positions.filter((p) => p.size)) expect(p.size, p.name).toEqual(auto[p.name]);
  });
});
