import {
  BaseEdge,
  Background,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useConnection,
  useInternalNode,
  useReactFlow,
  useStore,
  type Connection,
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
import { NEW_ELEMENT_LABEL, type NewElementType } from "./editing.js";
import { nameKey, type ScenarioBadge } from "./scenarios.js";

// 図。graph.ts で作ったノードと線を React Flow で描く。
// 線は「浮いた線」にして、箱の縁どうしを結ぶ（Insight Maker の図と同じ見た目にするため）。
// 編集モード（図の左上の「図を編集」で切り替える）のときだけ、箱と雲をドラッグで動かせて、離すと位置を保存する（弁は両端の真ん中についてくる）。
// 編集モードでは、左上の道具で要素を足す（種類を選んでから図の置きたい場所を押す）・選んだ要素やリンクを消すこともできる。
// リンクは、要素の縁からドラッグして別の要素の上で離すか、[＋線] を押してから元の要素 → 先の要素の順に押して引く。

// dimmed：要素を選んでいるとき、それにつながらないもの（薄くする）。ループを見せているときは、ループにないもの
// inLoop：ループを見せているとき、ループの線（太くする）
// badge：シナリオに注目している間、そのシナリオで変えた要素に付ける札（いまの値 → シナリオの値）
// linkable：編集モードで、縁からドラッグしてリンクを引ける（雲はモデルの要素でないので引けない）。linkFrom：[＋線] で元に選んだ要素
type NodeData = {
  g: GraphNode;
  selected: boolean;
  changed: boolean;
  dimmed: boolean;
  value?: string;
  badge?: ScenarioBadge;
  linkable: boolean;
  linkFrom: boolean;
};
type EdgeData = { g: GraphEdge; selected: boolean; changed: boolean; dimmed: boolean; inLoop: boolean };
type ModelNodeT = Node<NodeData, "model">;
type ModelEdgeT = Edge<EdgeData, "floating">;

const hidden = { opacity: 0, pointerEvents: "none" as const };
/** リンクを引き始める縁（上下左右の細い帯）。React Flow の接続の口（Handle）にして、引いている線の描画や離した先の判定に使う */
const LINK_EDGES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

function ModelNode({ data }: NodeProps<ModelNodeT>) {
  const { g, badge } = data;
  const cls = [
    "node",
    `node-${g.kind.toLowerCase()}`,
    data.selected ? "is-selected" : "",
    data.changed ? "is-changed" : "",
    data.dimmed ? "is-dimmed" : "",
    badge ? "is-scenario" : "",
    data.linkFrom ? "is-link-from" : "",
  ].join(" ");
  // リンクを引いている間だけ、要素全体を離す先にする（ふだんは要素を押す・動かすのを邪魔しない）
  const connecting = useConnection((c) => c.inProgress);
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
      {/* 口は編集モードでなくても置いておく（React Flow は口の位置を要素を描いたときに測るため）。編集モードでなければ押せない */}
      {/* 弁は小さく、まわりにフローの管と矢じりが集まるので、ドラッグで引き始める口は付けない（[＋線] では元にできる） */}
      {g.element &&
        g.kind !== "VALVE" &&
        LINK_EDGES.map((pos) => (
          <Handle
            key={pos}
            id={`link-${pos}`}
            type="source"
            position={pos}
            className={`link-handle link-handle-${pos} ${data.linkable ? "is-active" : ""}`}
            isConnectable={data.linkable}
            isConnectableStart={data.linkable}
            isConnectableEnd={data.linkable}
            title={data.linkable ? "ドラッグして、つなぐ先の要素の上で離すと、リンクを引きます" : undefined}
          />
        ))}
      {g.element && (
        <Handle
          id="link-drop"
          type="target"
          position={Position.Top}
          className={`link-drop ${data.linkable && connecting ? "is-active" : ""}`}
          isConnectable={data.linkable}
          isConnectableStart={false}
          isConnectableEnd={data.linkable}
        />
      )}
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
    return <BaseEdge id={id} path={`M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`} markerEnd={markerEnd} className={cls} interactionWidth={EDGE_HIT} />;
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
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={cls} interactionWidth={EDGE_HIT} />
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
  /** 注目しているシナリオ（凡例にカーソルを乗せている・左の欄で直している）。変えた要素に札を付け、枠をシナリオの線の色にする */
  scenario?: ScenarioMarks;
  /** 編集モード。オンのときだけ要素を動かせて、図の上に編集の道具の場所を出す。選ぶ・薄くするなどの見るための操作はいつでもできる */
  editable?: boolean;
  /** 図の左上の「図を編集」を押した。渡したときだけ切り替えを出す（図だけの表示では渡さない） */
  onEditableChange?(on: boolean): void;
  /** 画面で要素を足した・消した・名前を変えた直後の図。要素が増減しても（名前を変えるとノードの ID も変わる）、見る場所を合わせ直さない（置いた位置と見た目がずれないように） */
  keepView?: boolean;
  /** 図と下の欄の境界線をドラッグしている間。図の欄の大きさが変わっても、見る場所を合わせ直さない */
  holdView?: boolean;
  /** 編集モードで、図の at（図の座標）に要素を足す */
  onAdd?(type: NewElementType, at: Pos): void;
  /** 選んでいるリンク（図で線を押したとき）。選んだ要素と同じく、両端の要素とその線のほかを薄くする */
  selectedLink?: LinkEnds;
  onSelectLink?(link: LinkEnds): void;
  /** 編集モードで、from から to へリンクを引く（ドラッグか [＋線]）。引けるかどうかは呼ぶ側で確かめる */
  onLink?(from: string, to: string): void;
  /** 編集モードで消せる、選んでいる要素の名前かリンク（label は「A → B」）。なければ「削除」を押せない */
  removable?: { label: string; link: boolean };
  onRemove?(): void;
}

/** リンクの両端の要素名 */
export type LinkEnds = { from: string; to: string };

export interface ScenarioMarks {
  /** 要素名（nameKey）→ 札 */
  badges: Map<string, ScenarioBadge>;
  /** シナリオの線の色（CSS の色） */
  color: string;
}

type Pos = { x: number; y: number };

export function Diagram(props: DiagramProps) {
  const { graph, selected, changed, values, onMove, scenario, editable } = props;
  const flow = useReactFlow();
  // 足そうとしている要素の種類（ボタンを押してから、図の置きたい場所を押すまで）。LINK は [＋線] を押してから、元と先の要素を押すまで。
  // 編集モードを終えたり、別のモデルを開いたりしたらやめる
  const [placing, setPlacingState] = useState<NewElementType | "LINK">();
  // [＋線] で先に押した元の要素
  const [linkFrom, setLinkFrom] = useState<string>();
  const setPlacing = useCallback((p: NewElementType | "LINK" | undefined) => {
    setPlacingState(p);
    setLinkFrom(undefined);
  }, []);
  useEffect(() => {
    if (!editable) setPlacing(undefined);
  }, [editable, setPlacing]);
  useEffect(() => setPlacing(undefined), [props.modelName, setPlacing]);
  // Esc で足す（線を引く）のをやめる
  useEffect(() => {
    if (!placing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlacing(undefined);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing, setPlacing]);
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
  // 選んだリンクの線（図にあれば）。両端の要素とその線のほかを薄くする
  const linkEdge = useMemo(() => {
    const l = props.selectedLink;
    return l ? graph.edges.find((e) => e.kind === "link" && sameLink(graph, e, l)) : undefined;
  }, [graph, props.selectedLink]);
  const focus = useMemo(
    () =>
      loop ??
      (linkEdge ? { nodes: new Set([linkEdge.source, linkEdge.target]), edges: new Set([linkEdge.id]) } : selected ? connectedTo(graph, selected) : undefined),
    [graph, selected, loop, linkEdge],
  );

  const nodes = useMemo<ModelNodeT[]>(
    () =>
      placed.map((g) => {
        const isLinkFrom = placing === "LINK" && !!g.element && !!linkFrom && nameKey(g.element) === nameKey(linkFrom);
        return {
          id: g.id,
          type: "model",
          position: { x: g.x, y: g.y },
          width: g.width,
          height: g.height,
          data: {
            g,
            selected: !!g.element && !!selected && g.element.toLowerCase() === selected.toLowerCase(),
            changed: !!g.element && changed.has(g.element.toLowerCase()),
            // [＋線] で元に選んだ要素は、薄くしない
            dimmed: !!focus && !focus.nodes.has(g.id) && !isLinkFrom,
            value: g.kind === "STOCK" && g.element ? values[g.element] : undefined,
            badge: g.element ? scenario?.badges.get(nameKey(g.element)) : undefined,
            linkable: !!editable && !!g.element,
            linkFrom: isLinkFrom,
          },
          // 札がほかの要素の下に隠れないように、札の付いた要素を上に重ねる
          zIndex: g.element && scenario?.badges.has(nameKey(g.element)) ? 1 : undefined,
          draggable: !!editable && g.kind !== "VALVE",
          connectable: !!editable && !!g.element,
        };
      }),
    [placed, selected, changed, values, focus, scenario, editable, placing, linkFrom],
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
          selected: g.kind === "link" ? g.id === linkEdge?.id : !!g.element && !!selected && g.element.toLowerCase() === selected.toLowerCase(),
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
    [graph, selected, changed, focus, loop, linkEdge],
  );

  // ノードの id → 要素名（弁はフローの名前。雲はなし）
  const elementOf = useCallback((id: string) => graph.nodes.find((n) => n.id === id)?.element, [graph]);
  const { onLink, onSelect } = props;
  /** 縁からドラッグして、要素の上で離した */
  const onConnect = useCallback(
    (c: Connection) => {
      const [from, to] = [elementOf(c.source), elementOf(c.target)];
      if (editable && from && to) onLink?.(from, to);
    },
    [editable, elementOf, onLink],
  );
  /** 要素を押した。[＋線] の間は、元の要素 → 先の要素の順に選ぶ（雲は選べない）。それ以外は要素を選ぶ */
  const onNodeClick = (n: ModelNodeT) => {
    const element = n.data.g.element;
    if (placing !== "LINK" || !editable) return onSelect(element);
    if (!element) return;
    if (!linkFrom) return setLinkFrom(element);
    setPlacing(undefined);
    onLink?.(linkFrom, element);
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="system"
      // ループの線の色（--loop）を R / B で変える。要素を足す場所を選んでいる間は、十字のカーソルにする（線の両端を選んでいる間は、要素の上だけ）
      className={[props.loop ? `loop-${props.loop.kind.toLowerCase()}` : "", placing === "LINK" ? "is-linking" : placing ? "is-placing" : ""].join(" ").trim() || undefined}
      // 札と枠の色（--scenario）は、注目しているシナリオの線の色
      style={scenario ? ({ "--scenario": scenario.color } as React.CSSProperties) : undefined}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      nodesDraggable={!!editable}
      nodeDragThreshold={3}
      // リンクを引くのは編集モードのときだけ。要素の縁の口からドラッグする（口どうしの向きは問わない）
      nodesConnectable={!!editable}
      connectionMode={ConnectionMode.Loose}
      connectOnClick={false}
      onConnect={onConnect}
      connectionLineType={ConnectionLineType.Straight}
      connectionLineStyle={CONNECTION_LINE}
      // 離した点の下の要素にだけつなぐ（近くの要素に吸い付かせない）
      connectionRadius={0}
      elementsSelectable
      fitView
      // 画像にする図は全体を 1 枚に収める。ビューアでは名前が読める大きさより縮めない
      fitViewOptions={props.embed ? (props.loop ? EMBED_LOOP_FIT : EMBED_FIT) : VIEWER_FIT}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => onNodeClick(n)}
      // リンクの線を押すとリンクを選ぶ。フローの線は、そのフローを選ぶ。
      // 図だけの表示（発表モードの原因のスライド、view_diagram）では渡さない（線を押せない扱いにし、線の上からも見る場所を動かせるように）
      onEdgeClick={
        props.embed
          ? undefined
          : (ev, e) => {
              if (placing === "LINK" && editable) return;
              // 置く場所を選んでいる間は、線の上を押しても、そこに置く（何もないところを押したときと同じ）
              if (placing && placing !== "LINK" && editable) {
                setPlacing(undefined);
                return props.onAdd?.(placing, flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
              }
              const g = e.data?.g;
              if (g?.kind !== "link") return onSelect(g?.element);
              const [from, to] = [elementOf(g.source), elementOf(g.target)];
              if (from && to) props.onSelectLink?.({ from, to });
            }
      }
      onPaneClick={(e) => {
        // 線の両端を選んでいる間に何もないところを押したら、線を引くのをやめる
        if (!placing || !editable) return onSelect(undefined);
        setPlacing(undefined);
        if (placing !== "LINK") props.onAdd?.(placing, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <FitOnChange modelName={props.modelName} layoutKey={nodeIds} nodes={graph.nodes} embed={props.embed} badge={!!props.loop} keepView={props.keepView} holdView={props.holdView} />
      <Background gap={20} size={1} />
      {props.loop && <LoopBadge loop={props.loop} />}
      {props.onEditableChange && (
        <EditTools
          editable={!!editable}
          onEditableChange={props.onEditableChange}
          placing={placing}
          linkFrom={linkFrom}
          onPlace={setPlacing}
          removable={props.removable}
          onRemove={props.onRemove}
        />
      )}
      {!props.embed && <Controls showInteractive={false} fitViewOptions={VIEWER_FIT} />}
      {/* 全体のどこを見ているか。ドラッグとホイールで図を動かせる（図を隠しすぎないよう小さめにする） */}
      {!props.embed && <MiniMap pannable zoomable nodeColor={miniMapColor} nodeStrokeWidth={0} ariaLabel="図の全体" style={{ width: 150, height: 90 }} />}
    </ReactFlow>
  );
}

/**
 * 編集モードの切り替えと道具の場所（図の左上）。オフのときは「図を編集」だけを出す。
 * オンのときは、要素を足すボタン、線（リンク）を引くボタンと、選んだ要素やリンクを消すボタンを並べる。
 * 図は真ん中に合わせるので、要素は角より真ん中の上にかかりやすい。左下の操作部品と右下のミニマップとも離れている。
 * 足す場所や線の両端を選んでいる間だけ、何をすればよいかを添える（いつもは出さず、帯を小さく保つ）
 */
function EditTools({
  editable,
  onEditableChange,
  placing,
  linkFrom,
  onPlace,
  removable,
  onRemove,
}: {
  editable: boolean;
  onEditableChange(on: boolean): void;
  placing?: NewElementType | "LINK";
  linkFrom?: string;
  onPlace(type: NewElementType | "LINK" | undefined): void;
  removable?: { label: string; link: boolean };
  onRemove?(): void;
}) {
  const hint =
    placing === "LINK"
      ? linkFrom
        ? `「${linkFrom}」から引く先の要素を押してください（Esc でやめる）`
        : "線の元の要素を押してください（Esc でやめる）"
      : placing && "置きたい場所を押してください（Esc でやめる）";
  return (
    <Panel position="top-left" className={`edit-tools ${editable ? "on" : ""}`}>
      <button
        className={`edit-toggle ${editable ? "on" : ""}`}
        onClick={() => onEditableChange(!editable)}
        aria-pressed={editable}
        title={
          editable
            ? "図の編集を終えます。オンの間は、要素をドラッグで動かしたり、要素の縁からドラッグして別の要素の上で離し、線（リンク）を引いたりできます"
            : "図の形を変えられるようにします（要素を動かす・足す・消す、線を引く）。値やシナリオは、オフのままでもいつでも直せます"
        }
      >
        ✎ 図を編集
      </button>
      {editable && (
        <>
          {(Object.keys(NEW_ELEMENT_LABEL) as NewElementType[]).map((type) => (
            <button
              key={type}
              className={`edit-tool ${placing === type ? "on" : ""}`}
              aria-pressed={placing === type}
              onClick={() => onPlace(placing === type ? undefined : type)}
              title={`${NEW_ELEMENT_LABEL[type]}を足します。押してから、図の置きたい場所を押します`}
            >
              ＋{NEW_ELEMENT_LABEL[type]}
            </button>
          ))}
          <button
            className={`edit-tool ${placing === "LINK" ? "on" : ""}`}
            aria-pressed={placing === "LINK"}
            onClick={() => onPlace(placing === "LINK" ? undefined : "LINK")}
            title="線（リンク）を引きます。押してから、元の要素 → 先の要素の順に押します（要素の縁からドラッグしても引けます）"
          >
            ＋線
          </button>
          <button
            className="edit-tool danger"
            disabled={!removable}
            onClick={() => removable && onRemove?.()}
            title={
              removable
                ? removable.link
                  ? `リンク「${removable.label}」を消します（Delete キー）`
                  : `「${removable.label}」を消します（つながるリンクも消えます。Delete キー）`
                : "図で要素か線（リンク）を選ぶと、消せます"
            }
          >
            削除
          </button>
          {hint && <span className="edit-tools-hint">{hint}</span>}
        </>
      )}
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

/**
 * 線を押せる幅（React Flow の既定は 20px）。線の上からは見る場所を動かせないので、細めにして、図をドラッグしやすくする
 */
const EDGE_HIT = 10;

/** リンクを引いている間の線。図のリンクと同じ色と点線にする */
const CONNECTION_LINE = { stroke: "var(--link)", strokeWidth: 1.5, strokeDasharray: "5 4" };

/** 図のリンクの線が、両端の要素名の組と同じか（大文字と小文字は区別しない） */
function sameLink(graph: Graph, e: GraphEdge, l: LinkEnds): boolean {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.element ?? "";
  return nameKey(name(e.source)) === nameKey(l.from) && nameKey(name(e.target)) === nameKey(l.to);
}

const miniMapColor = (n: ModelNodeT) => (n.data.g.kind === "STOCK" ? "var(--stock-border)" : "var(--link)");

/**
 * 表示範囲を合わせ直す。別のモデルを開いたとき、配置を切り替えたとき、要素が増減したとき、図の欄の大きさが変わったとき。
 * 式や値が変わっただけのとき（AI が値を調整したなど）は動かさない。画面で要素を足した・消した・名前を変えたとき（keepView）も、増減では動かさない。
 * 境界線のドラッグで図の欄の大きさが変わったとき（holdView）も動かさない（ズームや位置を保つ）。
 * 全体が名前の読める大きさで入らないときは、ストックが入るように合わせる（ほかはドラッグやミニマップで見る）。
 */
function FitOnChange({
  modelName,
  layoutKey,
  nodes,
  embed,
  badge,
  keepView,
  holdView,
}: {
  modelName: string;
  layoutKey: string;
  nodes: GraphNode[];
  embed?: boolean;
  badge?: boolean;
  keepView?: boolean;
  holdView?: boolean;
}) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // 要素の並び（layoutKey）と、それ以外（モデル、図の欄の大きさ）を分けて覚える
  const view = `${modelName}:${Math.round(width / 40)}:${Math.round(height / 40)}`;
  const domNode = useStore((s) => s.domNode);
  const last = useRef({ view, layoutKey, modelName });
  // 境界線のドラッグで変わった大きさが、まだ届いていないか（届くのはドラッグを終えたあとのこともある）
  const held = useRef(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    const prev = last.current;
    last.current = { view, layoutKey, modelName };
    if (holdView) held.current = true;
    const hold = held.current;
    // ドラッグを終え、図の欄のいまの大きさが届いたら、ふだんどおりに戻す
    if (!holdView && domNode && domNode.offsetWidth === width && domNode.offsetHeight === height) held.current = false;
    if (hold && prev.modelName === modelName && prev.layoutKey === layoutKey) return;
    if (prev.view === view && (prev.layoutKey === layoutKey || keepView)) return;
    if (embed) {
      const padding = badge ? { top: BADGE_SPACE, bottom: FIT_PADDING, x: FIT_PADDING } : FIT_PADDING;
      requestAnimationFrame(() => flow.fitView({ padding, maxZoom: 1.5, duration: 200 }));
      return;
    }
    // 全体が名前の読める大きさで入らなければ、ストックが入るように合わせる
    const fit = fitTargets(nodesRef.current, width, height, FIT_PADDING);
    const targets = fit.nodes.map((n) => ({ id: n.id }));
    requestAnimationFrame(() => flow.fitView({ nodes: targets, padding: FIT_PADDING, maxZoom: fit.maxZoom, minZoom: MIN_FIT_ZOOM, duration: 200 }));
  }, [view, layoutKey, modelName, keepView, holdView, domNode, flow, embed, badge, width, height]);
  return null;
}
