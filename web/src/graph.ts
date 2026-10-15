// ModelJSON を図のノードと線にする。React に依存しない（テストから直接使う）。
//
// - ストック、変数、コンバーター、状態は箱のノード
// - フローは真ん中に「弁」のノードを置き、出元 → 弁 → 行き先の 2 本の線にする（リンクが弁につながれるように）
// - モデルの外の端は雲のノード
// - 座標はモデルにあればそれを使う。ない要素があれば dagre で自動配置する
import dagre from "@dagrejs/dagre";
import type { ModelElement, ModelJSON } from "../../src/core/modeljson.js";

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
  /** 自動配置にしたか */
  autoLayout: boolean;
  /** モデルの座標が足りないため自動配置にしたか */
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

export function toGraph(model: ModelJSON, options: { forceAutoLayout?: boolean } = {}): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const byName = new Map<string, GraphNode>();
  let missing = false;

  for (const el of model.elements) {
    if (!BOX_KINDS.has(el.type) || !el.name) continue;
    const kind = el.type as NodeKind;
    const [w, h] = el.display?.size ?? SIZE[kind];
    const [x, y] = hasCoordinates(el) ? el.display!.coordinates! : [0, 0];
    if (!hasCoordinates(el)) missing = true;
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
      if (!p) missing = true;
      const cloud: GraphNode = {
        id: cloudId(f.name!, which),
        kind: "CLOUD",
        label: "",
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

  const autoLayout = !!options.forceAutoLayout || missing;
  if (autoLayout) {
    layoutWithDagre(nodes, edges);
  } else {
    placeValves(valves);
  }
  for (const { node, a, b } of valves) {
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    node.labelSide = Math.abs(by - ay) > Math.abs(bx - ax) ? "right" : "below";
  }
  return { nodes, edges, autoLayout, missingCoordinates: missing };
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

/** dagre で左から右に並べる。フローの線を強く、リンクを弱く効かせる */
function layoutWithDagre(nodes: GraphNode[], edges: GraphEdge[]): void {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    // 弁はフローの名前を下に出すので、その分だけ場所をとる
    const width = n.kind === "VALVE" ? Math.max(60, n.label.length * 7) : n.width;
    const height = n.kind === "VALVE" ? n.height + 28 : n.height;
    g.setNode(n.id, { width, height });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target, { weight: e.kind === "link" ? 1 : 4, minlen: 1 }, e.id);
  }
  dagre.layout(g);
  for (const n of nodes) {
    const p = g.node(n.id);
    n.x = Math.round(p.x - n.width / 2);
    n.y = Math.round(p.y - (n.kind === "VALVE" ? (n.height + 28) / 2 : n.height / 2));
  }
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
