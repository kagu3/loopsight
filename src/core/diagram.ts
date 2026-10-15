// ModelJSON を図のノードと線にする。ビューアの画面と、MCP の view_diagram（図の確認）の両方で使う。
// React にも Node にも依存しない。
//
// - ストック、変数、コンバーター、状態は箱のノード
// - フローは真ん中に「弁」のノードを置き、出元 → 弁 → 行き先の 2 本の線にする（リンクが弁につながれるように）
// - モデルの外の端は雲のノード
// - 座標はモデルにあればそれを使う。ない要素があれば、書き出しと同じ簡易レイアウト（layoutModel）で並べる
import { layoutModel } from "./layout.js";
export { LINK_BEND, linkControlPoint } from "./geometry.js";
import type { ModelElement, ModelJSON } from "./modeljson.js";

export type NodeKind = "STOCK" | "VARIABLE" | "CONVERTER" | "STATE" | "VALVE" | "CLOUD";
export type Shape = "rect" | "ellipse";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** 表示名。雲は空 */
  label: string;
  /** モデルの要素名（雲はなし）。フローの弁はフローの名前 */
  element?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: Shape;
  /** 雲なら、どのフローのどちらの端か（位置を保存するときに使う） */
  cloudOf?: { flow: string; end: "from" | "to" };
  /** 弁の名前を出す側。フローが縦向きなら右、横向きなら下（線に重ならないように） */
  labelSide?: "below" | "right";
}

export type EdgeKind = "flow" | "transition" | "link";

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  source: string;
  target: string;
  /** 線の先に矢印を付けるか */
  arrow: boolean;
  /** リンクの極性（+ / -） */
  polarity?: "+" | "-";
  /** つながるモデルの要素名（フローやリンク） */
  element?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** モデルに座標のない要素があり、簡易レイアウトで並べたか（ファイルには保存していない） */
  missingCoordinates: boolean;
}

const SIZE: Record<NodeKind, [number, number]> = {
  STOCK: [100, 40],
  VARIABLE: [120, 50],
  CONVERTER: [120, 50],
  STATE: [100, 40],
  VALVE: [18, 18],
  CLOUD: [36, 26],
};

const BOX_KINDS = new Set(["STOCK", "VARIABLE", "CONVERTER", "STATE"]);

export const elementId = (name: string) => `el:${name.toLowerCase()}`;
const valveId = (name: string) => `valve:${name.toLowerCase()}`;
const cloudId = (name: string, end: "from" | "to") => `cloud:${name.toLowerCase()}:${end}`;

function hasCoordinates(el: ModelElement): boolean {
  const c = el.display?.coordinates;
  return Array.isArray(c) && c.length === 2 && !(c[0] === 0 && c[1] === 0);
}

const center = (n: GraphNode): [number, number] => [n.x + n.width / 2, n.y + n.height / 2];

/** 座標のない要素（箱か、モデルの外の端）があるか */
export function needsLayout(model: ModelJSON): boolean {
  for (const el of model.elements) {
    if (BOX_KINDS.has(el.type) && el.name && !hasCoordinates(el)) return true;
    if ((el.type === "FLOW" || el.type === "TRANSITION") && el.name) {
      if (!el.from && !el.display?.from_coordinates) return true;
      if (!el.to && !el.display?.to_coordinates) return true;
    }
  }
  return false;
}

export function toGraph(model: ModelJSON): Graph {
  if (needsLayout(model)) {
    // 座標のない要素だけを並べたコピーで描く（あるものは動かさない）
    const copy = structuredClone(model);
    layoutModel(copy);
    return { ...build(copy), missingCoordinates: true };
  }
  return { ...build(model), missingCoordinates: false };
}

function build(model: ModelJSON): Omit<Graph, "missingCoordinates"> {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byName = new Map<string, GraphNode>();

  for (const el of model.elements) {
    if (!BOX_KINDS.has(el.type) || !el.name) continue;
    const kind = el.type as NodeKind;
    const [w, h] = el.display?.size ?? SIZE[kind];
    const [x, y] = hasCoordinates(el) ? el.display!.coordinates! : [0, 0];
    const node: GraphNode = {
      id: elementId(el.name),
      kind,
      label: el.name,
      element: el.name,
      x,
      y,
      width: w,
      height: h,
      shape: kind === "VARIABLE" ? "ellipse" : "rect",
    };
    nodes.push(node);
    byName.set(el.name.toLowerCase(), node);
  }

  // フローと遷移：両端（ストックか雲）と弁
  const connectors = model.elements.filter((e) => (e.type === "FLOW" || e.type === "TRANSITION") && e.name);
  const valves: { node: GraphNode; a: GraphNode; b: GraphNode }[] = [];
  for (const f of connectors) {
    const kind: EdgeKind = f.type === "FLOW" ? "flow" : "transition";
    const end = (which: "from" | "to"): GraphNode => {
      const name = f[which];
      const found = name ? byName.get(name.toLowerCase()) : undefined;
      if (found) return found;
      const p = f.display?.[which === "from" ? "from_coordinates" : "to_coordinates"];
      const [w, h] = SIZE.CLOUD;
      const cloud: GraphNode = {
        id: cloudId(f.name!, which),
        kind: "CLOUD",
        label: "",
        cloudOf: { flow: f.name!, end: which },
        x: p ? p[0] - w / 2 : 0,
        y: p ? p[1] - h / 2 : 0,
        width: w,
        height: h,
        shape: "rect",
      };
      nodes.push(cloud);
      return cloud;
    };
    const a = end("from");
    const b = end("to");
    const [w, h] = SIZE.VALVE;
    const valve: GraphNode = { id: valveId(f.name!), kind: "VALVE", label: f.name!, element: f.name!, x: 0, y: 0, width: w, height: h, shape: "rect" };
    nodes.push(valve);
    byName.set(f.name!.toLowerCase(), valve);
    valves.push({ node: valve, a, b });
    edges.push({ id: `${valve.id}:in`, kind, source: a.id, target: valve.id, arrow: false, element: f.name! });
    edges.push({ id: `${valve.id}:out`, kind, source: valve.id, target: b.id, arrow: true, element: f.name! });
  }

  // リンク
  for (const l of model.elements.filter((e) => e.type === "LINK")) {
    const s = l.from ? byName.get(l.from.toLowerCase()) : undefined;
    const t = l.to ? byName.get(l.to.toLowerCase()) : undefined;
    if (!s || !t) continue;
    const pol = l.behavior?.polarity;
    edges.push({
      id: `link:${s.id}->${t.id}`,
      kind: "link",
      source: s.id,
      target: t.id,
      arrow: true,
      element: `${l.from} → ${l.to}`,
      ...(pol === "POSITIVE" ? { polarity: "+" as const } : pol === "NEGATIVE" ? { polarity: "-" as const } : {}),
    });
  }

  placeValves(valves);
  for (const { node, a, b } of valves) {
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    node.labelSide = Math.abs(by - ay) > Math.abs(bx - ax) ? "right" : "below";
  }
  return { nodes, edges };
}

/** 弁は両端の中心を結ぶ線の真ん中に置く */
function placeValves(valves: { node: GraphNode; a: GraphNode; b: GraphNode }[]): void {
  for (const { node, a, b } of valves) {
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    node.x = (ax + bx) / 2 - node.width / 2;
    node.y = (ay + by) / 2 - node.height / 2;
  }
}

/**
 * 表示している位置を、モデルに保存する形（upsert_elements の要素の変更）にする。
 * ids を渡すとそのノードだけ、渡さなければ弁以外のすべて（自動配置をまとめて保存するとき）。
 */
export function positionPatches(
  nodes: GraphNode[],
  ids?: Set<string>,
): { name: string; display: Record<string, [number, number]> }[] {
  const out: { name: string; display: Record<string, [number, number]> }[] = [];
  for (const n of nodes) {
    if (ids && !ids.has(n.id)) continue;
    if (n.kind === "CLOUD" && n.cloudOf) {
      // 雲の座標は中心
      const key = n.cloudOf.end === "from" ? "from_coordinates" : "to_coordinates";
      out.push({ name: n.cloudOf.flow, display: { [key]: [Math.round(n.x + n.width / 2), Math.round(n.y + n.height / 2)] } });
    } else if (n.kind !== "VALVE" && n.kind !== "CLOUD" && n.element) {
      // 箱の座標は左上
      out.push({ name: n.element, display: { coordinates: [Math.round(n.x), Math.round(n.y)] } });
    }
  }
  return out;
}

/**
 * 左上が MARGIN より左や上にはみ出していたら、全体をずらしたコピーを返す（はみ出していなければ undefined）。
 * 負の座標で保存すると、Insight Maker の Web 版で画面の外に出てしまうため。
 */
export function shiftIntoView(nodes: GraphNode[], margin = 20): GraphNode[] | undefined {
  const b = bounds(nodes);
  const dx = b.x < margin ? margin - b.x : 0;
  const dy = b.y < margin ? margin - b.y : 0;
  if (!dx && !dy) return undefined;
  return nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
}

/** 図の範囲 */
export function bounds(nodes: GraphNode[]): { x: number; y: number; width: number; height: number } {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...nodes.map((n) => n.x));
  const y = Math.min(...nodes.map((n) => n.y));
  const r = Math.max(...nodes.map((n) => n.x + n.width));
  const b = Math.max(...nodes.map((n) => n.y + n.height));
  return { x, y, width: r - x, height: b - y };
}

/**
 * 中心から点 (tx, ty) へ向かう線が、ノードの縁と交わる点。
 * 線を箱の縁から出すために使う。
 */
export function borderPoint(n: { x: number; y: number; width: number; height: number; shape: Shape }, tx: number, ty: number): [number, number] {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const a = n.width / 2;
  const b = n.height / 2;
  let t: number;
  if (n.shape === "ellipse") {
    t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
  } else {
    t = Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : b / Math.abs(dy));
  }
  return [cx + dx * t, cy + dy * t];
}
