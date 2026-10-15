// 図の見やすさを数字で確かめる。AI が配置を直すときの手がかり（MCP の view_diagram が返す）。
//
// - 箱どうし（雲も含む）の重なりと、フローの名前と箱の重なり
// - 線（フロー、リンク）が、つながっていない箱や雲の上を通っているところ
// - 線どうしの交差
// 線の形は画面と同じにする（フローは直線、リンクは linkControlPoint で曲げた 2 次ベジェ曲線）。
import { toGraph, type Graph, type GraphEdge, type GraphNode } from "./diagram.js";
import { flowLabelRect, linkSegments, segmentHitsRect, type Rect } from "./geometry.js";
import type { ModelJSON, Point } from "./modeljson.js";

export interface DiagramPosition {
  /** 要素の名前。雲は「<フロー名> の出元 / 行き先」 */
  name: string;
  type: string;
  /** 箱は左上の座標、雲は中心の座標（ModelJSON の display と同じ） */
  coordinates: [number, number];
  size?: [number, number];
}

export interface DiagramCheck {
  /** 座標のない要素があり、仮に並べて確かめたか */
  missing_coordinates: boolean;
  /** 図全体の範囲 */
  bounds: { x: number; y: number; width: number; height: number };
  overlaps: string[];
  lines_through_elements: string[];
  /** 線どうしの交差の数と、その例 */
  crossings: { count: number; examples: string[] };
  /** いまの位置（直すときは upsert_elements の display で変える） */
  positions: DiagramPosition[];
}

/** 線をいくつかの短い線分で表したもの */
interface Line {
  label: string;
  /** この線の両端のノード（その上を通るのは当然なので、確かめない） */
  ends: Set<string>;
  segments: [Point, Point][];
}

const MAX_EXAMPLES = 30;

function nameOf(n: GraphNode): string {
  if (n.kind === "CLOUD" && n.cloudOf) return `雲（${n.cloudOf.flow} の${n.cloudOf.end === "from" ? "出元" : "行き先"}）`;
  if (n.kind === "VALVE") return `フロー ${n.label} の弁`;
  return n.label;
}

const center = (n: GraphNode): Point => [n.x + n.width / 2, n.y + n.height / 2];
const rectOf = (n: GraphNode, shrink = 2): Rect => ({ x: n.x + shrink, y: n.y + shrink, w: n.width - 2 * shrink, h: n.height - 2 * shrink });

function linesOf(graph: Graph): Line[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: Line[] = [];
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    lines.push({ label: lineLabel(e, s, t), ends: new Set([s.id, t.id]), segments: segmentsOf(e, center(s), center(t)) });
  }
  return lines;
}

function lineLabel(e: GraphEdge, s: GraphNode, t: GraphNode): string {
  if (e.kind === "link") return `リンク ${nameOf(s)} → ${nameOf(t).replace(/^フロー (.*) の弁$/, "$1")}`;
  return `フロー ${e.element ?? ""}（${e.id.endsWith(":in") ? `${nameOf(s)} → 弁` : `弁 → ${nameOf(t)}`}）`;
}

function segmentsOf(e: GraphEdge, a: Point, b: Point): [Point, Point][] {
  return e.kind === "link" ? linkSegments(a, b) : [[a, b]];
}

/** 2 本の線分が交わるか（端を共有するだけのものは数えない） */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function checkDiagram(model: ModelJSON): DiagramCheck {
  const graph = toGraph(model);
  const boxes = graph.nodes.filter((n) => n.kind !== "VALVE");
  const valves = graph.nodes.filter((n) => n.kind === "VALVE");

  // 箱どうしの重なり
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        overlaps.push(`${nameOf(a)} と ${nameOf(b)}`);
      }
    }
  }

  // フローの名前（弁の横か下）と箱の重なり
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const v of valves) {
    const a = graph.edges.find((e) => e.target === v.id && e.kind !== "link");
    const b = graph.edges.find((e) => e.source === v.id && e.kind !== "link");
    const na = a && byId.get(a.source);
    const nb = b && byId.get(b.target);
    if (!na || !nb) continue;
    const r = flowLabelRect(v.label, center(na), center(nb));
    for (const n of boxes) {
      if (r.x < n.x + n.width && n.x < r.x + r.w && r.y < n.y + n.height && n.y < r.y + r.h) {
        overlaps.push(`フロー ${v.label} の名前 と ${nameOf(n)}`);
      }
    }
  }

  // 線が、つながっていない箱・雲・弁の上を通っているところ
  const lines = linesOf(graph);
  const through: string[] = [];
  for (const line of lines) {
    for (const n of [...boxes, ...valves]) {
      if (line.ends.has(n.id)) continue;
      const r = rectOf(n, n.kind === "VALVE" ? 0 : 2);
      if (line.segments.some(([a, b]) => segmentHitsRect(a, b, r))) through.push(`${line.label} が ${nameOf(n)} の上を通る`);
    }
  }

  // 線どうしの交差（同じノードにつながる線どうしは数えない）
  let count = 0;
  const examples: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if ([...a.ends].some((id) => b.ends.has(id))) continue;
      const hit = a.segments.some(([p1, p2]) => b.segments.some(([p3, p4]) => segmentsCross(p1, p2, p3, p4)));
      if (!hit) continue;
      count++;
      if (examples.length < MAX_EXAMPLES) examples.push(`${a.label} と ${b.label}`);
    }
  }

  const positions: DiagramPosition[] = boxes.map((n) =>
    n.kind === "CLOUD"
      ? { name: nameOf(n), type: "CLOUD", coordinates: center(n).map(Math.round) as [number, number] }
      : { name: n.label, type: n.kind, coordinates: [Math.round(n.x), Math.round(n.y)], size: [n.width, n.height] },
  );

  const xs = graph.nodes.map((n) => n.x);
  const ys = graph.nodes.map((n) => n.y);
  const x = xs.length ? Math.min(...xs) : 0;
  const y = ys.length ? Math.min(...ys) : 0;
  const right = graph.nodes.length ? Math.max(...graph.nodes.map((n) => n.x + n.width)) : 0;
  const bottom = graph.nodes.length ? Math.max(...graph.nodes.map((n) => n.y + n.height)) : 0;

  return {
    missing_coordinates: graph.missingCoordinates,
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) },
    overlaps: overlaps.slice(0, MAX_EXAMPLES),
    lines_through_elements: through.slice(0, MAX_EXAMPLES),
    crossings: { count, examples },
    positions,
  };
}
