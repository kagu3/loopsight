import {
  BaseEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useInternalNode,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import { borderPoint, type Graph, type GraphEdge, type GraphNode } from "./graph.js";

// 図。graph.ts で作ったノードと線を React Flow で描く。
// 線は「浮いた線」にして、箱の縁どうしを結ぶ（Insight Maker の図と同じ見た目にするため）。

type NodeData = { g: GraphNode; selected: boolean; changed: boolean; value?: string };
type EdgeData = { g: GraphEdge; selected: boolean; changed: boolean };
type ModelNodeT = Node<NodeData, "model">;
type ModelEdgeT = Edge<EdgeData, "floating">;

const hidden = { opacity: 0, pointerEvents: "none" as const };

function ModelNode({ data }: NodeProps<ModelNodeT>) {
  const { g } = data;
  const cls = ["node", `node-${g.kind.toLowerCase()}`, data.selected ? "is-selected" : "", data.changed ? "is-changed" : ""].join(" ");
  return (
    <div className={cls} style={{ width: g.width, height: g.height }} title={g.element}>
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
          <span className="node-label">{g.label}</span>
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

  const cls = ["edge", `edge-${data.g.kind}`, data.selected ? "is-selected" : "", data.changed ? "is-changed" : ""].join(" ");
  if (data.g.kind !== "link") {
    const p1 = endAt(a, ca, cb);
    const p2 = endAt(b, cb, ca);
    return <BaseEdge id={id} path={`M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`} markerEnd={markerEnd} className={cls} />;
  }
  // リンクは少し曲げる（フローの線と見分けやすく）
  const mx = (ca[0] + cb[0]) / 2;
  const my = (ca[1] + cb[1]) / 2;
  const dx = cb[0] - ca[0];
  const dy = cb[1] - ca[1];
  const k = 0.18;
  const ctrl: [number, number] = [mx - dy * k, my + dx * k];
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
        <text x={lx + 6} y={ly - 6} className="edge-polarity">
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
}

export function Diagram(props: DiagramProps) {
  const { graph, selected, changed, values } = props;
  // 要素が増えたり減ったりしたときも表示範囲を合わせ直す
  const nodeIds = useMemo(() => graph.nodes.map((n) => n.id).sort().join("|"), [graph]);
  const nodes = useMemo<ModelNodeT[]>(
    () =>
      graph.nodes.map((g) => ({
        id: g.id,
        type: "model",
        position: { x: g.x, y: g.y },
        width: g.width,
        height: g.height,
        data: {
          g,
          selected: !!g.element && g.element === selected,
          changed: !!g.element && changed.has(g.element.toLowerCase()),
          value: g.kind === "STOCK" && g.element ? values[g.element] : undefined,
        },
        draggable: false,
        connectable: false,
      })),
    [graph, selected, changed, values],
  );
  const edges = useMemo<ModelEdgeT[]>(
    () =>
      graph.edges.map((g) => ({
        id: g.id,
        type: "floating",
        source: g.source,
        target: g.target,
        data: { g, selected: !!g.element && g.element === selected, changed: !!g.element && changed.has(g.element.toLowerCase()) },
        markerEnd: g.arrow ? { type: MarkerType.ArrowClosed, width: g.kind === "link" ? 14 : 12, height: g.kind === "link" ? 14 : 12 } : undefined,
        selectable: false,
      })),
    [graph, selected, changed],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode="system"
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1.5 }}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => props.onSelect(n.data.g.element)}
      onPaneClick={() => props.onSelect(undefined)}
    >
      <FitOnChange modelName={props.modelName} layoutKey={`${graph.autoLayout ? "auto" : "model"}:${nodeIds}`} />
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

/**
 * 表示範囲を合わせ直す。別のモデルを開いたとき、配置を切り替えたとき、要素が増減したとき、図の欄の大きさが変わったとき。
 * 式や値が変わっただけのとき（AI が値を調整したなど）は動かさない。
 */
function FitOnChange({ modelName, layoutKey }: { modelName: string; layoutKey: string }) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const key = `${modelName}:${layoutKey}:${Math.round(width / 40)}:${Math.round(height / 40)}`;
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    requestAnimationFrame(() => flow.fitView({ padding: 0.15, maxZoom: 1.5, duration: 200 }));
  }, [key, flow]);
  return null;
}
