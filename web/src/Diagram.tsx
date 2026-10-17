import {
  BaseEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useInternalNode,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ElementPatch } from "../../src/viewer/api.js";
import { borderPoint, connectedTo, fitTargets, linkControlPoint, loopFocus, MIN_FIT_ZOOM, positionPatches, shiftIntoView, type Graph, type GraphEdge, type GraphNode } from "../../src/core/diagram.js";
import { LOOP_KIND_LABEL, type LoopView } from "../../src/core/loops.js";
import { nameKey, type ScenarioBadge } from "./scenarios.js";

// 図。graph.ts で作ったノードと線を React Flow で描く。
// 線は「浮いた線」にして、箱の縁どうしを結ぶ（Insight Maker の図と同じ見た目にするため）。
// 編集モードのときだけ、箱と雲をドラッグで動かせて、離すと位置を保存する（弁は両端の真ん中についてくる）。

// dimmed：要素を選んでいるとき、それにつながらないもの（薄くする）。ループを見せているときは、ループにないもの
// inLoop：ループを見せているとき、ループの線（太くする）
// badge：施策に注目している間、その施策で変えた要素に付ける札（いまの値 → 施策の値）
type NodeData = { g: GraphNode; selected: boolean; changed: boolean; dimmed: boolean; value?: string; badge?: ScenarioBadge };
type EdgeData = { g: GraphEdge; selected: boolean; changed: boolean; dimmed: boolean; inLoop: boolean };
type ModelNodeT = Node<NodeData, "model">;
type ModelEdgeT = Edge<EdgeData, "floating">;

const hidden = { opacity: 0, pointerEvents: "none" as const };

function ModelNode({ data }: NodeProps<ModelNodeT>) {
  const { g, badge } = data;
  const cls = [
    "node",
    `node-${g.kind.toLowerCase()}`,
    data.selected ? "is-selected" : "",
    data.changed ? "is-changed" : "",
    data.dimmed ? "is-dimmed" : "",
    badge ? "is-scenario" : "",
  ].join(" ");
  return (
    <div className={cls} style={{ width: g.width, height: g.height }} title={badge?.title ?? g.element}>
      {/* 札は要素の上に出す。マウスは通す（札の下の要素や背景を押せるように）。全文は要素のツールチップで出す */}
      {badge && (
        <span className="scenario-badge">
          {badge.initial && <small>初期値</small>}
          {badge.text}
        </span>
      )}
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
      {g.kind === "VALVE" ? (
        <>
          <svg viewBox="0 0 18 18" width={g.width} height={g.height} aria-hidden>
            <path d="M2 3 L16 15 L16 3 L2 15 Z" className="valve-shape" />
          </svg>
          <span className={`valve-label side-${g.labelSide ?? "below"}`}>{g.label}</span>
        </>
      ) : g.kind === "CLOUD" ? (
        <svg viewBox="0 0 36 26" width={g.width} height={g.height} aria-label="モデルの外">
          <path
            className="cloud-shape"
            d="M9 22 C3 22 2 15 7 14 C6 8 13 6 16 10 C18 4 27 5 27 11 C33 11 34 19 29 21 C28 23 25 23 24 22 Z"
          />
        </svg>
      ) : (
        <div className="node-body">
          {/* 名前の行は core（boxLayout）で決めてある。ここでは折り返さずにそのまま描く。
              ただしモデルで決まった大きさの箱に入りきらないときは、前と同じく箱の中で折り返す */}
          {g.wrapLabel ? (
            <span className="node-label is-wrapped">{g.label}</span>
          ) : (
            (g.lines ?? [g.label]).map((line, i) => (
              <span key={i} className="node-label">
                {line}
              </span>
            ))
          )}
          {data.value !== undefined && <span className="node-value">{data.value}</span>}
        </div>
      )}
    </div>
  );
}

function FloatingEdge({ id, source, target, markerEnd, data }: EdgeProps<ModelEdgeT>) {
  const s = useInternalNode<ModelNodeT>(source);
  const t = useInternalNode<ModelNodeT>(target);
  if (!s || !t || !data) return null;
  const box = (n: typeof s) => ({ ...n.data.g, x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y });
  const a = box(s);
  const b = box(t);
  const ca: [number, number] = [a.x + a.width / 2, a.y + a.height / 2];
  const cb: [number, number] = [b.x + b.width / 2, b.y + b.height / 2];
  // 弁には縁ではなく中心でつなぐ
  const endAt = (n: typeof a, c: [number, number], toward: [number, number]) => (n.kind === "VALVE" ? c : borderPoint(n, toward[0], toward[1]));

  const cls = ["edge", `edge-${data.g.kind}`, data.selected ? "is-selected" : "", data.changed ? "is-changed" : "", data.dimmed ? "is-dimmed" : "", data.inLoop ? "is-loop" : ""].join(" ");
  if (data.g.kind !== "link") {
    const p1 = endAt(a, ca, cb);
    const p2 = endAt(b, cb, ca);
    return <BaseEdge id={id} path={`M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`} markerEnd={markerEnd} className={cls} />;
  }
  // リンクは少し曲げる（フローの線と見分けやすく）
  const ctrl = linkControlPoint(ca, cb);
  const p1 = endAt(a, ca, ctrl);
  const p2 = endAt(b, cb, ctrl);
  const path = `M${p1[0]},${p1[1]} Q${ctrl[0]},${ctrl[1]} ${p2[0]},${p2[1]}`;
  // 極性は線の終わり近くに出す
  const q = 0.8;
  const lx = (1 - q) ** 2 * p1[0] + 2 * (1 - q) * q * ctrl[0] + q * q * p2[0];
  const ly = (1 - q) ** 2 * p1[1] + 2 * (1 - q) * q * ctrl[1] + q * q * p2[1];
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} />
      {data.g.polarity && (
        <text x={lx + 6} y={ly - 6} className={data.dimmed ? "edge-polarity is-dimmed" : "edge-polarity"}>
          {data.g.polarity}
        </text>
      )}
    </>
  );
}

const nodeTypes = { model: ModelNode };
const edgeTypes = { floating: FloatingEdge };

export interface DiagramProps {
  graph: Graph;
  /** モデルが変わったら図の表示範囲を合わせ直す */
  modelName: string;
  selected?: string;
  changed: Set<string>;
  values: Record<string, string>;
  onSelect(element: string | undefined): void;
  /** 動かした位置を保存する。失敗したらその文を返す */
  onMove(patches: ElementPatch[]): Promise<string | undefined>;
  /** 図だけを見せる表示（MCP の view_diagram が画像にする）。操作の道具を出さない */
  embed?: boolean;
  /**
   * 目立たせるループ（find_loops の結果や、筋書きの「原因」のスライドから渡す）。
   * ループの要素と線だけをふつうに出してほかを薄くし、図の左上にループの名前と R / B を出す。
   * 要素を選んでいても、こちらを優先する
   */
  loop?: LoopView;
  /** 注目している施策（凡例にカーソルを乗せている・左の欄で直している）。変えた要素に札を付け、枠を施策の線の色にする */
  scenario?: ScenarioMarks;
  /** 編集モード。オンのときだけ要素を動かせて、図の上に編集の道具の場所を出す。選ぶ・薄くするなどの見るための操作はいつでもできる */
  editable?: boolean;
}

export interface ScenarioMarks {
  /** 要素名（nameKey）→ 札 */
  badges: Map<string, ScenarioBadge>;
  /** 施策の線の色（CSS の色） */
  color: string;
}

type Pos = { x: number; y: number };

export function Diagram(props: DiagramProps) {
  const { graph, selected, changed, values, onMove, scenario, editable } = props;
  // 要素が増えたり減ったりしたときも表示範囲を合わせ直す
  const nodeIds = useMemo(() => graph.nodes.map((n) => n.id).sort().join("|"), [graph]);

  // ドラッグ中（と保存が終わるまで）の位置。新しい図が来たら捨てる。
  // ただし保存を待っているあいだは捨てない（先の保存の結果で、あとから動かした要素が戻らないように）
  const [moved, setMoved] = useState<Map<string, Pos>>(new Map());
  const pendingSaves = useRef(0);
  useEffect(() => {
    if (pendingSaves.current === 0) setMoved(new Map());
  }, [graph]);

  // 弁 → 両端のノード
  const valveEnds = useMemo(() => {
    const ends = new Map<string, { a?: string; b?: string }>();
    for (const e of graph.edges) {
      if (e.kind === "link") continue;
      if (e.id.endsWith(":in")) ends.set(e.target, { ...ends.get(e.target), a: e.source });
      if (e.id.endsWith(":out")) ends.set(e.source, { ...ends.get(e.source), b: e.target });
    }
    return ends;
  }, [graph]);

  /** 動かした位置を当てたノード。弁は、両端のどちらかが動いていれば真ん中に置き直す */
  const placed = useMemo<GraphNode[]>(() => {
    if (!moved.size) return graph.nodes;
    const byId = new Map(graph.nodes.map((n) => [n.id, { ...n, ...(moved.get(n.id) ?? {}) }]));
    for (const [valve, { a, b }] of valveEnds) {
      const v = byId.get(valve);
      const na = a ? byId.get(a) : undefined;
      const nb = b ? byId.get(b) : undefined;
      if (!v || !na || !nb || !(moved.has(a!) || moved.has(b!))) continue;
      v.x = (na.x + na.width / 2 + nb.x + nb.width / 2) / 2 - v.width / 2;
      v.y = (na.y + na.height / 2 + nb.y + nb.height / 2) / 2 - v.height / 2;
    }
    return graph.nodes.map((n) => byId.get(n.id)!);
  }, [graph, moved, valveEnds]);

  // 選んだ要素につながる線とノード。ほかは薄くする（配置を変えずに、見たいところを読めるように）。
  // ループを見せているときは、ループの要素と線
  // 呼ぶ側が毎回新しい配列を渡しても作り直さないよう、要素名の並びで覚える
  const loopKey = props.loop && JSON.stringify(props.loop.elements);
  const loop = useMemo(() => (loopKey ? loopFocus(graph, JSON.parse(loopKey) as string[]) : undefined), [graph, loopKey]);
  const focus = useMemo(() => loop ?? (selected ? connectedTo(graph, selected) : undefined), [graph, selected, loop]);

  const nodes = useMemo<ModelNodeT[]>(
    () =>
      placed.map((g) => ({
        id: g.id,
        type: "model",
        position: { x: g.x, y: g.y },
        width: g.width,
        height: g.height,
        data: {
          g,
          selected: !!g.element && !!selected && g.element.toLowerCase() === selected.toLowerCase(),
          changed: !!g.element && changed.has(g.element.toLowerCase()),
          dimmed: !!focus && !focus.nodes.has(g.id),
          value: g.kind === "STOCK" && g.element ? values[g.element] : undefined,
          badge: g.element ? scenario?.badges.get(nameKey(g.element)) : undefined,
        },
        // 札がほかの要素の下に隠れないように、札の付いた要素を上に重ねる
        zIndex: g.element && scenario?.badges.has(nameKey(g.element)) ? 1 : undefined,
        draggable: !!editable && g.kind !== "VALVE",
        connectable: false,
      })),
    [placed, selected, changed, values, focus, scenario, editable],
  );

  const onNodesChange = useCallback((changes: NodeChange<ModelNodeT>[]) => {
    const updates = changes.filter((c) => c.type === "position" && c.position);
    if (!updates.length) return;
    setMoved((prev) => {
      const next = new Map(prev);
      for (const c of updates) if (c.type === "position" && c.position) next.set(c.id, c.position);
      return next;
    });
  }, []);

  // 離したら位置を保存する
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const onNodeDragStop = useCallback(
    async (_: unknown, _node: ModelNodeT, dragged: ModelNodeT[]) => {
      // 座標のない要素を仮に並べているときは、見えている配置をまとめて保存する（座標のない要素を残さない）。
      // 左や上にはみ出したときも、全体をずらしてまとめて保存する
      const shifted = shiftIntoView(placedRef.current);
      const ids = graph.missingCoordinates || shifted ? undefined : new Set(dragged.map((n) => n.id));
      const patches = positionPatches(shifted ?? placedRef.current, ids);
      if (!patches.length) return;
      pendingSaves.current++;
      try {
        await onMove(patches);
      } finally {
        pendingSaves.current--;
        // 保存がすべて終わったら、図の位置（保存した位置か、失敗なら元の位置）に任せる
        if (pendingSaves.current === 0) setMoved(new Map());
      }
    },
    [graph, onMove],
  );
  const edges = useMemo<ModelEdgeT[]>(
    () =>
      graph.edges.map((g) => ({
        id: g.id,
        type: "floating",
        source: g.source,
        target: g.target,
        data: {
          g,
          selected: !!g.element && !!selected && g.element.toLowerCase() === selected.toLowerCase(),
          changed: !!g.element && changed.has(g.element.toLowerCase()),
          dimmed: !!focus && !focus.edges.has(g.id),
          inLoop: !!loop?.edges.has(g.id),
        },
        // 矢印の色は線と同じトークンにする（React Flow は色を style に入れるので CSS 変数が効く）
        markerEnd: g.arrow
          ? loop?.edges.has(g.id)
            ? { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "var(--loop)" }
            : g.kind === "link"
              ? { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--link)" }
              : { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "var(--flow)" }
          : undefined,
        selectable: false,
      })),
    [graph, selected, changed, focus, loop],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="system"
      // ループの線の色（--loop）を R / B で変える
      className={props.loop ? `loop-${props.loop.kind.toLowerCase()}` : undefined}
      // 札と枠の色（--scenario）は、注目している施策の線の色
      style={scenario ? ({ "--scenario": scenario.color } as React.CSSProperties) : undefined}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodesDraggable={!!editable}
      nodeDragThreshold={3}
      nodesConnectable={false}
      elementsSelectable
      fitView
      // 画像にする図は全体を 1 枚に収める。ビューアでは名前が読める大きさより縮めない
      fitViewOptions={props.embed ? (props.loop ? EMBED_LOOP_FIT : EMBED_FIT) : VIEWER_FIT}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => props.onSelect(n.data.g.element)}
      onPaneClick={() => props.onSelect(undefined)}
    >
      <FitOnChange modelName={props.modelName} layoutKey={nodeIds} nodes={graph.nodes} embed={props.embed} badge={!!props.loop} />
      <Background gap={20} size={1} />
      {props.loop && <LoopBadge loop={props.loop} />}
      {editable && <EditTools />}
      {!props.embed && <Controls showInteractive={false} fitViewOptions={VIEWER_FIT} />}
      {/* 全体のどこを見ているか。ドラッグとホイールで図を動かせる（図を隠しすぎないよう小さめにする） */}
      {!props.embed && <MiniMap pannable zoomable nodeColor={miniMapColor} nodeStrokeWidth={0} ariaLabel="図の全体" style={{ width: 150, height: 90 }} />}
    </ReactFlow>
  );
}

/**
 * 編集モードの道具の場所（図の左上）。いまは編集中であることと、できることだけを出す。
 * 要素を足す・消す、線を引くボタンは、ここに右へ並べる。
 * 図は真ん中に合わせるので、要素は角より真ん中の上にかかりやすい。左下の操作部品と右下のミニマップとも離れている
 */
function EditTools() {
  return (
    <Panel position="top-left" className="edit-tools">
      <span className="edit-tools-label">編集モード</span>
      <span className="edit-tools-hint">要素をドラッグで動かせます</span>
    </Panel>
  );
}

/** 目立たせているループの名前と R / B */
function LoopBadge({ loop }: { loop: LoopView }) {
  return (
    <Panel position="top-left" className={`loop-badge loop-${loop.kind.toLowerCase()}`}>
      <span className="loop-kind" aria-hidden>
        {loop.kind === "unknown" ? "?" : loop.kind}
      </span>
      <span className="loop-text">
        <span className="loop-name">{loop.name}</span>
        {loop.name !== LOOP_KIND_LABEL[loop.kind] && <span className="loop-kind-label">{LOOP_KIND_LABEL[loop.kind]}</span>}
      </span>
    </Panel>
  );
}

const FIT_PADDING = 0.15;
// 毎回作り直すと React Flow が合わせ直しの途中の設定を上書きするので、ここで 1 度だけ作る
const EMBED_FIT = { padding: 0.04, maxZoom: 1.5 };
/** ループの札（左上）の分だけ、上を空ける。図だけの表示で、札が図に重ならないように */
const BADGE_SPACE = "76px" as const;
const EMBED_LOOP_FIT = { padding: { top: BADGE_SPACE, bottom: 0.04, x: 0.04 }, maxZoom: 1.5 };
const VIEWER_FIT = { padding: FIT_PADDING, maxZoom: 1.5, minZoom: MIN_FIT_ZOOM };

const miniMapColor = (n: ModelNodeT) => (n.data.g.kind === "STOCK" ? "var(--stock-border)" : "var(--link)");

/**
 * 表示範囲を合わせ直す。別のモデルを開いたとき、配置を切り替えたとき、要素が増減したとき、図の欄の大きさが変わったとき。
 * 式や値が変わっただけのとき（AI が値を調整したなど）は動かさない。
 * 全体が名前の読める大きさで入らないときは、ストックが入るように合わせる（ほかはドラッグやミニマップで見る）。
 */
function FitOnChange({ modelName, layoutKey, nodes, embed, badge }: { modelName: string; layoutKey: string; nodes: GraphNode[]; embed?: boolean; badge?: boolean }) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const key = `${modelName}:${layoutKey}:${Math.round(width / 40)}:${Math.round(height / 40)}`;
  const last = useRef(key);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    if (embed) {
      const padding = badge ? { top: BADGE_SPACE, bottom: FIT_PADDING, x: FIT_PADDING } : FIT_PADDING;
      requestAnimationFrame(() => flow.fitView({ padding, maxZoom: 1.5, duration: 200 }));
      return;
    }
    // 全体が名前の読める大きさで入らなければ、ストックが入るように合わせる
    const fit = fitTargets(nodesRef.current, width, height, FIT_PADDING);
    const targets = fit.nodes.map((n) => ({ id: n.id }));
    requestAnimationFrame(() => flow.fitView({ nodes: targets, padding: FIT_PADDING, maxZoom: fit.maxZoom, minZoom: MIN_FIT_ZOOM, duration: 200 }));
  }, [key, flow, embed, badge, width, height]);
  return null;
}
