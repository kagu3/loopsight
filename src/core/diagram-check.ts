// 図の見やすさを数字で確かめる。AI が配置を直すときの手がかり（MCP の view_diagram が返す）。
//
// - 箱どうし（雲と注釈も含む）の重なりと、フローの名前と箱の重なり
// - 線（フロー、リンク）が、つながっていない箱や雲、注釈の上を通っているところ
// - 線どうしの交差
// - リンクがフローの名前の上を通るところ
// - 1 か所に集まる線：1 つの要素にほぼ同じ向きでつながる線（重なって見分けにくい）と、
//   1 つの弁に集まる多くのリンク（リンクは弁の中心につなぐので、1 点に集まる）
// - グループの囲みどうしの重なりと、グループに属さない要素が囲みの中に入っているところ
// 線の形は画面と同じにする（フローは直線、リンクは linkControlPoint で曲げた 2 次ベジェ曲線）。
import { toGraph, type Graph, type GraphEdge, type GraphNode } from "./diagram.js";
import { flowLabelRect, linkControlPoint, linkSegments, segmentHitsRect, type Rect } from "./geometry.js";
import { areasOverlap, checkGroups, groupAreas, type GroupColor } from "./groups.js";
import { nameKey, type ModelJSON, type Point } from "./modeljson.js";

export interface DiagramPosition {
  /** 要素の名前。雲は「<フロー名> の出元 / 行き先」、注釈は id */
  name: string;
  type: string;
  /** 箱と注釈は左上の座標、雲は中心の座標（ModelJSON の display、注釈の coordinates と同じ） */
  coordinates: [number, number];
  size?: [number, number];
  /** 強調した要素か（大きさは強調で大きくしたもの） */
  emphasis?: boolean;
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
  /** リンクがフローの名前の上を通るところ */
  lines_through_labels: string[];
  /** 1 か所に集まる線（ほぼ同じ向きでつながる線と、1 つの弁に集まる多くのリンク） */
  converging_lines: string[];
  /** グループの囲みどうしの重なり、グループに属さない要素が囲みの中に入っているところ、groups の書き方の誤り */
  group_issues: string[];
  /** グループの囲み（グループがあるときだけ）。位置と大きさは属する要素から決まる */
  groups?: { name: string; color: GroupColor; elements: string[]; area: { x: number; y: number; width: number; height: number } }[];
  /** いまの位置（直すときは upsert_elements の display で変える） */
  positions: DiagramPosition[];
}

/** 線をいくつかの短い線分で表したもの */
interface Line {
  label: string;
  edge: GraphEdge;
  /** この線の両端のノード（その上を通るのは当然なので、確かめない） */
  ends: Set<string>;
  segments: [Point, Point][];
  /** 両端のノードから見た、線が出ていく向き（ラジアン）。リンクは曲げてあるので制御点の向き */
  angles: Map<string, number>;
}

const MAX_EXAMPLES = 30;
/** これより向きの差が小さい線は、まとまって見える */
const BUNDLE_ANGLE = (12 * Math.PI) / 180;
/** 1 つの弁にこの数以上のリンクが入ると、1 点に集まって見分けにくい */
const MANY_LINKS_TO_VALVE = 5;

function nameOf(n: GraphNode): string {
  if (n.kind === "CLOUD" && n.cloudOf) return `雲（${n.cloudOf.flow} の${n.cloudOf.end === "from" ? "出元" : "行き先"}）`;
  if (n.kind === "VALVE") return `フロー ${n.label} の弁`;
  if (n.kind === "NOTE") {
    const text = n.label.replace(/\s+/g, " ");
    return `注釈 ${n.note}（${[...text].length > 12 ? `${[...text].slice(0, 12).join("")}…` : text}）`;
  }
  return n.label;
}

const center = (n: GraphNode): Point => [n.x + n.width / 2, n.y + n.height / 2];
const rectOf = (n: GraphNode, shrink = 2): Rect => ({ x: n.x + shrink, y: n.y + shrink, w: n.width - 2 * shrink, h: n.height - 2 * shrink });
/** from から to への向き（ラジアン） */
const angleOf = (from: Point, to: Point): number => Math.atan2(to[1] - from[1], to[0] - from[0]);

function linesOf(graph: Graph): Line[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: Line[] = [];
  for (const e of graph.edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    const a = center(s);
    const b = center(t);
    const c = e.kind === "link" ? linkControlPoint(a, b) : undefined;
    const angles = new Map([
      [s.id, angleOf(a, c ?? b)],
      [t.id, angleOf(b, c ?? a)],
    ]);
    lines.push({ label: lineLabel(e, s, t), edge: e, ends: new Set([s.id, t.id]), segments: segmentsOf(e, a, b), angles });
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
  const labels: { valve: GraphNode; rect: Rect }[] = [];
  for (const v of valves) {
    const a = graph.edges.find((e) => e.target === v.id && e.kind !== "link");
    const b = graph.edges.find((e) => e.source === v.id && e.kind !== "link");
    const na = a && byId.get(a.source);
    const nb = b && byId.get(b.target);
    if (!na || !nb) continue;
    const r = flowLabelRect(v.label, center(na), center(nb));
    labels.push({ valve: v, rect: r });
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

  // リンクがフローの名前の上を通るところ（その弁につながるリンクも含める。名前を横切るので読みにくい）
  const throughLabels: string[] = [];
  for (const line of lines) {
    if (line.edge.kind !== "link") continue;
    for (const { valve, rect } of labels) {
      if (line.segments.some(([a, b]) => segmentHitsRect(a, b, rect))) throughLabels.push(`${line.label} が フロー ${valve.label} の名前の上を通る`);
    }
  }

  // 1 か所に集まる線
  const converging: string[] = [];
  for (const n of graph.nodes) {
    const touching = lines.filter((l) => l.ends.has(n.id));
    if (n.kind === "VALVE") {
      const links = touching.filter((l) => l.edge.kind === "link");
      if (links.length >= MANY_LINKS_TO_VALVE) converging.push(`${nameOf(n)} に ${links.length} 本のリンクが 1 点に集まる：${links.map((l) => l.label).join("、")}`);
    }
    const around = touching
      .map((l) => ({ line: l, angle: l.angles.get(n.id)! }))
      .sort((p, q) => p.angle - q.angle);
    for (const group of bundles(around)) {
      const spread = Math.round(((group.at(-1)!.angle - group[0]!.angle + 2 * Math.PI) % (2 * Math.PI)) * (180 / Math.PI));
      converging.push(`${nameOf(n)} に ${group.length} 本の線がほぼ同じ向き（${spread}° の幅）でつながる：${group.map((g) => g.line.label).join("、")}`);
    }
  }

  // グループの囲み
  const areas = groupAreas(graph.nodes, graph.groups);
  const groupIssues = checkGroups(model);
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      if (areasOverlap(areas[i]!, areas[j]!)) groupIssues.push(`グループ ${areas[i]!.name} と グループ ${areas[j]!.name} の囲みが重なる`);
    }
  }
  const grouped = new Set(areas.flatMap((a) => a.nodes));
  const groupOfFlow = new Map((graph.groups ?? []).flatMap((g) => g.elements.map((e) => [nameKey(e), g.name] as const)));
  for (const a of areas) {
    for (const n of graph.nodes) {
      if (grouped.has(n.id)) continue;
      // 注釈はグループに属さないものなので、囲みの中に置いてもよい
      if (n.kind === "NOTE") continue;
      // 雲は、フローと同じグループの囲みに入っていてよい
      if (n.kind === "CLOUD" && n.cloudOf && groupOfFlow.get(nameKey(n.cloudOf.flow)) === a.name) continue;
      if (areasOverlap(a, n)) groupIssues.push(`${nameOf(n)}（どのグループにも属さない）が グループ ${a.name} の囲みの中に入っている`);
    }
  }

  const positions: DiagramPosition[] = boxes.map((n) =>
    n.kind === "CLOUD"
      ? { name: nameOf(n), type: "CLOUD", coordinates: center(n).map(Math.round) as [number, number] }
      : n.kind === "NOTE"
        ? { name: n.note!, type: "NOTE", coordinates: [Math.round(n.x), Math.round(n.y)], size: [n.width, n.height] }
        : { name: n.label, type: n.kind, coordinates: [Math.round(n.x), Math.round(n.y)], size: [n.width, n.height], ...(n.emphasis ? { emphasis: true } : {}) },
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
    lines_through_labels: throughLabels.slice(0, MAX_EXAMPLES),
    converging_lines: converging.slice(0, MAX_EXAMPLES),
    group_issues: groupIssues.slice(0, MAX_EXAMPLES),
    ...(areas.length
      ? {
          groups: areas.map((a) => ({
            name: a.name,
            color: a.color,
            elements: graph.groups!.find((g) => g.name === a.name)!.elements,
            area: { x: Math.round(a.x), y: Math.round(a.y), width: Math.round(a.width), height: Math.round(a.height) },
          })),
        }
      : {}),
    positions,
  };
}

/**
 * 向きの順に並べた線を、となりとの差が BUNDLE_ANGLE より小さいものどうしでまとめる（2 本以上のまとまりだけ返す）。
 * 向きは一周するので、最後と最初もつなげて調べる。
 * 少しずつずれた線がどこまでもつながらないよう、まとまりの先頭からの幅が BUNDLE_ANGLE 以上になったら分ける。
 */
function bundles<T extends { angle: number }>(sorted: T[]): T[][] {
  if (sorted.length < 2) return [];
  const diff = (a: number, b: number) => (b - a + 2 * Math.PI) % (2 * Math.PI);
  const gap = (i: number) => diff(sorted[i]!.angle, sorted[(i + 1) % sorted.length]!.angle);
  // まとまりの切れ目（となりと離れているところ）から始める。切れ目がなければ最初の線から始める
  const found = sorted.findIndex((_, i) => gap(i) >= BUNDLE_ANGLE);
  const start = found < 0 ? sorted.length - 1 : found;
  const groups: T[][] = [];
  let current: T[] = [];
  const close = () => {
    if (current.length >= 2) groups.push(current);
    current = [];
  };
  for (let k = 1; k <= sorted.length; k++) {
    const i = (start + k) % sorted.length;
    if (current.length > 0 && diff(current[0]!.angle, sorted[i]!.angle) >= BUNDLE_ANGLE) close();
    current.push(sorted[i]!);
    if (gap(i) >= BUNDLE_ANGLE) close();
  }
  close();
  return groups;
}
