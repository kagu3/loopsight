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
  ViewportPortal,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AnnotationPatch, ElementPatch } from "../../src/viewer/api.js";
import { annotationPatches, borderPoint, connectedTo, fitTargets, linkControlPoint, loopFocus, MIN_FIT_ZOOM, positionPatches, shiftIntoView, type Graph, type GraphEdge, type GraphNode } from "../../src/core/diagram.js";
import { groupAreas, type GroupArea } from "../../src/core/groups.js";
import { LOOP_KIND_LABEL, type LoopView } from "../../src/core/loops.js";
import { delayMarkPath } from "../../src/core/delay.js";
import { exportDiagram, type ExportedDiagram } from "./diagramExport.js";
import type { NodeValue } from "./diagramValues.js";
import { NEW_ELEMENT_LABEL, type FlowEnd, type NewElementType } from "./editing.js";
import { formulaText, type FormulaToken, type FormulaView } from "./formulaValues.js";
import { formatTime } from "./format.js";
import { nameKey, type ScenarioBadge } from "./scenarios.js";

// 図。graph.ts で作ったノードと線を React Flow で描く。
// 線は「浮いた線」にして、箱の縁どうしを結ぶ（Insight Maker の図と同じ見た目にするため）。
// 編集モード（図の左上の「図を編集」で切り替える）のときだけ、箱と雲をドラッグで動かせて、離すと位置を保存する（弁は両端の真ん中についてくる）。
// 右上の「値を表示」をオンにすると、ストック・フロー・変数に、その時点の値と最初からの変化を出す（分析や説明のときだけ使う）。
// オンの間に要素を選ぶと、その要素の式に値を入れたものを、箱の横（ほかの箱に重なりにくい側）に出す。
// 編集モードでは、左上の道具で要素を足す（種類を選んでから図の置きたい場所を押す）・選んだ要素やリンクを消すこともできる。
// リンクは、要素の縁からドラッグして別の要素の上で離すか、[＋線] を押してから元の要素 → 先の要素の順に押して引く。
// フローの端は、端の近くの丸（つまみ）をドラッグして、ストックの上で離すとそのストックに、何もないところで離すとそこに置いた雲につなぎ替える。
// 遅れの印（display.delay）のあるリンクとフローは、線の途中に ‖ を描く（フローは弁から行き先までの線の真ん中、リンクは曲線の真ん中。極性の文字は線の終わり近くなので重ならない）。
// グループ（モデルの groups）があれば、属する要素をまとめて薄い色の長方形で囲み（要素や線の後ろに描く）、図の下に凡例を出す。
// 囲みは押せない（下の背景を押したことになる）。要素を動かすと、囲みも付いてくる。
// 注釈（どこにもつながらない文字だけのもの）も、編集モードで足す・動かす・消すことができる。文字は詳細欄の「編集」で直す。

// dimmed：要素を選んでいるとき、それにつながらないもの（薄くする）。ループを見せているときは、ループにないもの
// inLoop：ループを見せているとき、ループの線（太くする）
// badge：シナリオに注目している間、そのシナリオで変えた要素に付ける札（いまの値 → シナリオの値）
// linkable：編集モードで、縁からドラッグしてリンクを引ける（雲はモデルの要素でないので引けない）。linkFrom：[＋線] で元に選んだ要素
// dropTarget：フローの端をドラッグしている間、離すとつなぐストック
// live：「値を表示」がオンのとき、その時点の値と最初からの変化（unit は時点に添える時間の単位）
type NodeData = {
  g: GraphNode;
  selected: boolean;
  changed: boolean;
  dimmed: boolean;
  value?: string;
  badge?: ScenarioBadge;
  linkable: boolean;
  linkFrom: boolean;
  dropTarget: boolean;
  live?: { v: NodeValue; unit: string };
};
// grip：編集モードで、つなぎ替えられるフローの端（:in の線は元の側＝from、:out の線は先の側＝to）。grabbed：その端をドラッグしている
type EdgeData = {
  g: GraphEdge;
  selected: boolean;
  changed: boolean;
  dimmed: boolean;
  inLoop: boolean;
  grip?: FlowEnd;
  grabbed: boolean;
  onGrip?(e: React.PointerEvent, flow: string, end: FlowEnd, valve: Pos): void;
};
type ModelNodeT = Node<NodeData, "model">;
type ModelEdgeT = Edge<EdgeData, "floating">;
/** グループの囲み。dimmed：ループを見せている・要素を選んでいるとき（ほかの要素と同じく薄くする） */
type GroupNodeT = Node<{ area: GroupArea; dimmed: boolean }, "groupArea">;
type DiagramNodeT = ModelNodeT | GroupNodeT;

const hidden = { opacity: 0, pointerEvents: "none" as const };
/** リンクを引き始める縁（上下左右の細い帯）。React Flow の接続の口（Handle）にして、引いている線の描画や離した先の判定に使う */
const LINK_EDGES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

/** 「値を表示」の値（120（+20%）・12 週）。増えたか減ったかで色を変え、変化が大きいほど濃くする */
function LiveValue({ live, className }: { live: { v: NodeValue; unit: string }; className: string }) {
  const { v, unit } = live;
  return (
    <span className={`${className} live-value is-${v.direction} level-${v.level}`}>
      {v.value}
      {v.change !== undefined && <span className="live-change">（{v.change}）</span>}
      {v.time !== undefined && (
        <span className="live-time">
          ・{formatTime(v.time)} {unit}
        </span>
      )}
    </span>
  );
}

function ModelNode({ data }: NodeProps<ModelNodeT>) {
  const { g, badge, live } = data;
  const cls = [
    "node",
    `node-${g.kind.toLowerCase()}`,
    g.emphasis ? "is-emphasis" : "",
    data.selected ? "is-selected" : "",
    data.changed ? "is-changed" : "",
    data.dimmed ? "is-dimmed" : "",
    badge ? "is-scenario" : "",
    data.linkFrom ? "is-link-from" : "",
    data.dropTarget ? "is-drop-target" : "",
  ].join(" ");
  // リンクを引いている間だけ、要素全体を離す先にする（ふだんは要素を押す・動かすのを邪魔しない）
  const connecting = useConnection((c) => c.inProgress);
  if (g.kind === "NOTE") {
    // 注釈は文字だけ。行は core（annotationLayout）で決めてあるので、折り返さずにそのまま描く。つなぐ口は付けない
    return (
      <div className={cls} style={{ width: g.width, height: g.height }}>
        {(g.lines ?? [g.label]).map((line, i) => (
          <span key={i} className="note-line">
            {line || "\u00a0"}
          </span>
        ))}
      </div>
    );
  }
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
          <span className={`valve-label side-${g.labelSide ?? "below"} ${live ? "has-value" : ""}`}>
            {g.label}
            {/* 値は弁の名前の下に並べる（弁の横に出す） */}
            {live && <LiveValue live={live} className="valve-value" />}
          </span>
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
      {/* 値は箱の下に出す。ストックは、下に並ぶフローの名前と重ならないよう箱の上に出す（シナリオの札があるときは、札が上なので下） */}
      {live && g.kind !== "VALVE" && <LiveValue live={live} className={g.kind === "STOCK" && !badge ? "node-live is-above" : "node-live"} />}
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

  const cls = [
    "edge",
    `edge-${data.g.kind}`,
    data.selected ? "is-selected" : "",
    data.changed ? "is-changed" : "",
    data.dimmed ? "is-dimmed" : "",
    data.inLoop ? "is-loop" : "",
    data.grabbed ? "is-grabbed" : "",
  ].join(" ");
  if (data.g.kind !== "link") {
    const p1 = endAt(a, ca, cb);
    const p2 = endAt(b, cb, ca);
    const { grip, onGrip } = data;
    // つまみは、端から少し弁の側に寄せて置く（端の上は要素の縁と重なり、リンクを引き始める口に隠れるため）。先の側は矢じりの手前に置く
    const [end, valve] = grip === "from" ? [p1, cb] : [p2, ca];
    const len = Math.hypot(valve[0] - end[0], valve[1] - end[1]) || 1;
    const k = Math.min(grip === "from" ? GRIP_OFFSET : GRIP_OFFSET + ARROW_SIZE, len / 3) / len;
    const at: [number, number] = [end[0] + (valve[0] - end[0]) * k, end[1] + (valve[1] - end[1]) * k];
    return (
      <>
        <BaseEdge id={id} path={`M${p1[0]},${p1[1]} L${p2[0]},${p2[1]}`} markerEnd={markerEnd} className={cls} interactionWidth={EDGE_HIT} />
        {data.g.delay && <DelayMark at={[(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]} dir={[p2[0] - p1[0], p2[1] - p1[1]]} data={data} />}
        {grip && onGrip && (
          <circle
            className="flow-end-grip nodrag nopan"
            cx={at[0]}
            cy={at[1]}
            r={5}
            onPointerDown={(e) => onGrip(e, data.g.element!, grip, { x: valve[0], y: valve[1] })}
          >
            <title>ドラッグして、ストックの上で離すとそのストックに、何もないところで離すと雲（モデルの外）につなぎ替えます</title>
          </circle>
        )}
      </>
    );
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
      {/* 遅れの印は曲線の真ん中（t = 0.5）に、曲線の向きに直交させて描く */}
      {data.g.delay && (
        <DelayMark
          at={[(p1[0] + 2 * ctrl[0] + p2[0]) / 4, (p1[1] + 2 * ctrl[1] + p2[1]) / 4]}
          dir={[p2[0] - p1[0], p2[1] - p1[1]]}
          data={data}
        />
      )}
      {data.g.polarity && (
        <text x={lx + 6} y={ly - 6} className={data.dimmed ? "edge-polarity is-dimmed" : "edge-polarity"}>
          {data.g.polarity}
        </text>
      )}
    </>
  );
}

/** 遅れの印（‖）。線と同じく、選んだ・ループ・薄くするで見た目を変える。線の中に描くので、印を押しても線を選べる */
function DelayMark({ at, dir, data }: { at: [number, number]; dir: [number, number]; data: EdgeData }) {
  const cls = [
    "edge-delay",
    `edge-${data.g.kind}`,
    data.selected ? "is-selected" : "",
    data.changed ? "is-changed" : "",
    data.dimmed ? "is-dimmed" : "",
    data.inLoop ? "is-loop" : "",
  ].join(" ");
  return (
    <path className={cls} d={delayMarkPath(at, dir)}>
      <title>遅れ（時間がたってから効く）</title>
    </path>
  );
}

/** グループの囲み。名前は左上の隅に出す */
function GroupAreaNode({ data }: NodeProps<GroupNodeT>) {
  const { area, dimmed } = data;
  return (
    <div className={`group-area group-${area.color} ${dimmed ? "is-dimmed" : ""}`} style={{ width: area.width, height: area.height }}>
      <span className="group-area-name">{area.name}</span>
    </div>
  );
}

/** 凡例（グループの色と名前の一覧）。グループから作るので、色を変えても直し忘れない */
function GroupLegend({ areas }: { areas: GroupArea[] }) {
  return (
    <Panel position="bottom-center" className="group-legend" aria-label="グループの凡例">
      {areas.map((a) => (
        <span key={a.name} className="group-legend-item">
          <span className={`group-swatch group-${a.color}`} aria-hidden />
          {a.name}
        </span>
      ))}
    </Panel>
  );
}

const nodeTypes = { model: ModelNode, groupArea: GroupAreaNode };
const edgeTypes = { floating: FloatingEdge };

export interface DiagramProps {
  graph: Graph;
  /** モデルが変わったら図の表示範囲を合わせ直す */
  modelName: string;
  selected?: string;
  changed: Set<string>;
  values: Record<string, string>;
  onSelect(element: string | undefined): void;
  /** 動かした位置を保存する（要素と注釈。同じ 1 回の保存にする）。失敗したらその文を返す */
  onMove(patches: ElementPatch[], notes?: AnnotationPatch[]): Promise<string | undefined>;
  /** 図だけを見せる表示（MCP の view_diagram が画像にする）。操作の道具を出さない */
  embed?: boolean;
  /**
   * 目立たせるループ（find_loops の結果から渡す）。
   * ループの要素と線だけをふつうに出してほかを薄くし、図の左上にループの名前と R / B を出す。
   * 要素を選んでいても、こちらを優先する
   */
  loop?: LoopView;
  /** 目立たせるのをやめる（作業画面だけ渡す）。ループの札に ✕ を出す */
  onLoopClose?(): void;
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
  /** 編集モードで、図の at（図の座標）に注釈を足す。渡したときだけ「＋注釈」を出す */
  onAddNote?(at: Pos): void;
  /** 選んでいる注釈の id */
  selectedNote?: string;
  /** 図で注釈を押した */
  onSelectNote?(id: string): void;
  /** 選んでいるリンク（図で線を押したとき）。選んだ要素と同じく、両端の要素とその線のほかを薄くする */
  selectedLink?: LinkEnds;
  onSelectLink?(link: LinkEnds): void;
  /** 編集モードで、from から to へリンクを引く（ドラッグか [＋線]）。引けるかどうかは呼ぶ側で確かめる */
  onLink?(from: string, to: string): void;
  /** 編集モードで、フローの端をつなぎ替える。to はストックの名前か、雲を置く図の座標。つなげるかどうかは呼ぶ側で確かめる */
  onReconnect?(flow: string, end: FlowEnd, to: string | Pos): void;
  /** 編集モードで消せる、選んでいる要素の名前かリンク（label は「A → B」）か注釈。なければ「削除」を押せない */
  removable?: Removable;
  onRemove?(): void;
  /** 「値を表示」がオンのときの、要素に出す値。あれば、ストックの最後の値（values）は出さない */
  liveValues?: NodeValues;
  /** 図の右上の「値を表示」の切り替えと、値を出すシナリオの選択。渡したときだけ出す（図だけの表示では渡さない） */
  valueTools?: ValueTools;
  /** 図の右上の「値を表示」の右に並べるもの（ビューアの「広げる」）。渡したときだけ出す */
  paneTools?: ReactNode;
  /**
   * 図の右上の「書き出す」を押した。create を呼ぶと、図を SVG と PNG にする（できなければ例外）。渡したときだけボタンを出す。
   * 画像は、いま見ている表示のまま（「値を表示」の値などは入れ、選んでいる要素の枠や薄くする表示は外す）
   */
  onExport?(create: () => Promise<ExportedDiagram>): Promise<void>;
  /** 「値を表示」がオンで要素を選んでいるときの、値を入れた式。選んだ要素の横に出す */
  formula?: SelectedFormula;
}

/** 選んだ要素の、値を入れた式 */
export interface SelectedFormula {
  /** 選んだ要素の名前（式を出す箱） */
  element: string;
  view: FormulaView;
  /** どの時点の値か（「12 週の値（最大の振れ）」など） */
  caption: string;
  /** 添える一言（ストックの最大の振れの時点は出入りがほぼ釣り合うので、カーソルを乗せる案内など） */
  hint?: string;
}

/** 図の要素に出す値 */
export interface NodeValues {
  /** 要素名（nameKey）→ 値 */
  values: Map<string, NodeValue>;
  /** 時点に添える時間の単位（週など） */
  unit: string;
}

/** 図の右上の「値を表示」 */
export interface ValueTools {
  on: boolean;
  onChange(on: boolean): void;
  /** 値を出せるシナリオの名前。なければ選択を出さない */
  scenarios: string[];
  /** 何も変えない実行の名前（モデルの baseline。なければ「いまのまま」） */
  baseline: string;
  /** 値を出しているシナリオ（undefined は何も変えない実行） */
  scenario?: string;
  onScenario(name: string | undefined): void;
  /** いまどの時点の値を出しているか（「12 週の値」「それぞれの最大の振れ」） */
  caption: string;
}

/** 編集モードで消せるもの。link はリンク、note は注釈 */
export type Removable = { label: string; link: boolean; note?: boolean };

/** 置こうとしているもの。要素の種類か、線（リンク）か、注釈 */
type Placing = NewElementType | "LINK" | "NOTE";

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
  const { graph, selected, changed, values, onMove, scenario, editable, liveValues } = props;
  const flow = useReactFlow();
  // 足そうとしている要素の種類（ボタンを押してから、図の置きたい場所を押すまで）。LINK は [＋線] を押してから、元と先の要素を押すまで。
  // 編集モードを終えたり、別のモデルを開いたりしたらやめる
  const [placing, setPlacingState] = useState<Placing>();
  // [＋線] で先に押した元の要素
  const [linkFrom, setLinkFrom] = useState<string>();
  const setPlacing = useCallback((p: Placing | undefined) => {
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

  // ドラッグしているフローの端。valve は弁の中心、at はいまのマウスの位置、target は離すとつなぐストックのノード（図の座標）
  const [grab, setGrab] = useState<{ flow: string; end: FlowEnd; valve: Pos; at: Pos; target?: string }>();
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const { onReconnect } = props;
  // ドラッグをやめて、window に付けた listener を外す（図を閉じたときにも呼ぶ）
  const endGrab = useRef<() => void>(undefined);
  useEffect(() => () => endGrab.current?.(), []);
  /**
   * フローの端のつまみを押した。離すまでマウスを追い、離した場所でつなぎ替える。Esc でやめる。
   * 離したあとの click は 1 回だけ捨てる（何もないところで離すと、図を押したことになり、選ぶのをやめたり、置く場所を選んでいる途中なら要素を足したりしてしまうため）
   */
  const onGrip = useCallback(
    (e: React.PointerEvent, flowName: string, end: FlowEnd, valve: Pos) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      endGrab.current?.();
      const start = { x: e.clientX, y: e.clientY };
      // 押した指（マウス）だけを追う。2 本目の指で終わらないように
      const pointer = e.pointerId;
      // 図の窓。外（左の欄やグラフの上）で離したら、見えないところに雲を置かないよう、やめにする
      const pane = (e.currentTarget as Element).closest(".react-flow");
      // 離した点の下のノード（雲は除く。雲の上で離したときは、そこに雲を置く）
      const under = (p: Pos) => placedRef.current.find((n) => n.kind !== "CLOUD" && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height);
      const track = (ev: { clientX: number; clientY: number }) => {
        const at = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        return { at, node: under(at) };
      };
      setGrab({ flow: flowName, end, valve, at: track(e).at });
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer) return;
        const { at, node } = track(ev);
        setGrab((g) => g && { ...g, at, target: node?.kind === "STOCK" ? node.id : undefined });
      };
      /** 離したすぐあとの click を捨てる。click は pointerup と同じ流れで続けて起きるので、そのあとのタイマーで外す */
      const swallowClick = () => {
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancelled);
        window.removeEventListener("keydown", onKey);
        endGrab.current = undefined;
        setGrab(undefined);
      };
      const cancelled = (ev: PointerEvent) => ev.pointerId === pointer && finish();
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer) return;
        finish();
        // 押しただけ（ほとんど動かしていない）なら、つなぎ替えない（押したつまみの線を選ぶ）
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
        swallowClick();
        if (!editableRef.current) return;
        const r = pane?.getBoundingClientRect();
        if (r && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) return;
        const { at, node } = track(ev);
        onReconnect?.(flowName, end, node?.element ?? at);
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        finish();
        // まだボタンを押したままなので、離したときの click も捨てる
        window.addEventListener("pointerup", swallowClick, { capture: true, once: true });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancelled);
      window.addEventListener("keydown", onKey);
      endGrab.current = finish;
    },
    [flow, onReconnect],
  );

  // マウスを動かすたびに線とノードを作り直さないよう、ドラッグしている端と離す先だけを取り出す
  const dropTarget = grab?.target;
  const grabFlow = grab?.flow;
  const grabEnd = grab?.end;
  const grabbed = useMemo(() => (grabFlow && grabEnd ? { flow: grabFlow, end: grabEnd } : undefined), [grabFlow, grabEnd]);

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

  // グループの囲み。動かしている要素にも付いていくよう、いまの位置（placed）から決める
  const areas = useMemo(() => groupAreas(placed, graph.groups), [placed, graph.groups]);
  const groupNodes = useMemo<GroupNodeT[]>(
    () =>
      areas.map((area) => ({
        id: `group:${area.name.toLowerCase()}`,
        type: "groupArea",
        position: { x: area.x, y: area.y },
        width: area.width,
        height: area.height,
        data: { area, dimmed: !!focus },
        // 要素と線の後ろに描き、押せないようにする
        zIndex: -1,
        selectable: false,
        draggable: false,
        connectable: false,
        focusable: false,
        style: { pointerEvents: "none" },
      })),
    [areas, focus],
  );

  // 表示範囲を合わせるときに、全体を入れるなら囲みも入れる（端の囲みやグループの名前が切れないように）
  const groupIdKey = groupNodes.map((n) => n.id).join("|");
  const groupIds = useMemo(() => (groupIdKey ? groupIdKey.split("|") : []), [groupIdKey]);

  const modelNodes = useMemo<ModelNodeT[]>(
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
            selected:
              g.kind === "NOTE"
                ? !!g.note && !!props.selectedNote && nameKey(g.note) === nameKey(props.selectedNote)
                : !!g.element && !!selected && g.element.toLowerCase() === selected.toLowerCase(),
            changed: !!g.element && changed.has(g.element.toLowerCase()),
            // [＋線] で元に選んだ要素は、薄くしない。注釈は図の説明なので、ループを見せているときも薄くしない（読めるように）
            dimmed: !!focus && !focus.nodes.has(g.id) && !isLinkFrom && g.kind !== "NOTE",
            // 「値を表示」がオンのときは、ストックの最後の値を出さない（同じところに値が 2 つ並ばないように）
            value: g.kind === "STOCK" && g.element && !liveValues ? values[g.element] : undefined,
            live: liveValues && g.element && LIVE_KINDS.has(g.kind) ? liveOf(liveValues, g.element) : undefined,
            badge: g.element ? scenario?.badges.get(nameKey(g.element)) : undefined,
            linkable: !!editable && !!g.element,
            linkFrom: isLinkFrom,
            dropTarget: !!dropTarget && dropTarget === g.id,
          },
          // 札がほかの要素の下に隠れないように、札の付いた要素を上に重ねる
          zIndex: g.element && scenario?.badges.has(nameKey(g.element)) ? 1 : undefined,
          draggable: !!editable && g.kind !== "VALVE",
          connectable: !!editable && !!g.element,
        };
      }),
    [placed, selected, props.selectedNote, changed, values, focus, scenario, editable, placing, linkFrom, dropTarget, liveValues],
  );
  const nodes = useMemo<DiagramNodeT[]>(() => (groupNodes.length ? [...groupNodes, ...modelNodes] : modelNodes), [groupNodes, modelNodes]);

  const onNodesChange = useCallback((changes: NodeChange<DiagramNodeT>[]) => {
    const updates = changes.filter((c) => c.type === "position" && c.position);
    if (!updates.length) return;
    setMoved((prev) => {
      const next = new Map(prev);
      for (const c of updates) if (c.type === "position" && c.position) next.set(c.id, c.position);
      return next;
    });
  }, []);

  // 離したら位置を保存する
  const onNodeDragStop = useCallback(
    async (_: unknown, _node: DiagramNodeT, dragged: DiagramNodeT[]) => {
      // 座標のない要素を仮に並べているときは、見えている配置をまとめて保存する（座標のない要素を残さない）。
      // 左や上にはみ出したときも、全体をずらしてまとめて保存する
      const shifted = shiftIntoView(placedRef.current);
      const ids = graph.missingCoordinates || shifted ? undefined : new Set(dragged.map((n) => n.id));
      const patches = positionPatches(shifted ?? placedRef.current, ids);
      // 注釈は、動かしたものだけ（全体をずらしたときはすべて）
      const notes = annotationPatches(shifted ?? placedRef.current, shifted ? undefined : new Set(dragged.map((n) => n.id)));
      if (!patches.length && !notes.length) return;
      pendingSaves.current++;
      try {
        await onMove(patches, notes);
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
          // つなぎ替えられるのは、編集モードのフローの端
          grip: editable && !props.embed && onReconnect && g.kind === "flow" ? (g.id.endsWith(":in") ? "from" : "to") : undefined,
          grabbed: !!grabbed && g.kind === "flow" && nameKey(g.element ?? "") === nameKey(grabbed.flow) && g.id.endsWith(grabbed.end === "from" ? ":in" : ":out"),
          onGrip,
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
    [graph, selected, changed, focus, loop, linkEdge, editable, props.embed, onReconnect, grabbed, onGrip],
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
  /** 置く場所を選んでいる間に、図の at を押した。要素か注釈を足す */
  const placeAt = (p: NewElementType | "NOTE", at: Pos) => {
    setPlacing(undefined);
    if (p === "NOTE") props.onAddNote?.(at);
    else props.onAdd?.(p, at);
  };
  /** 要素を押した。[＋線] の間は、元の要素 → 先の要素の順に選ぶ（雲と注釈は選べない）。それ以外は要素か注釈を選ぶ */
  const onNodeClick = (n: DiagramNodeT) => {
    if (n.type !== "model") return;
    const element = n.data.g.element;
    const note = n.data.g.note;
    if (placing !== "LINK" || !editable) return note !== undefined && props.onSelectNote ? props.onSelectNote(note) : onSelect(element);
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
      fitViewOptions={props.embed ? (props.loop ? (areas.length ? EMBED_LOOP_LEGEND_FIT : EMBED_LOOP_FIT) : areas.length ? EMBED_LEGEND_FIT : EMBED_FIT) : VIEWER_FIT}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => onNodeClick(n)}
      // リンクの線を押すとリンクを選ぶ。フローの線は、そのフローを選ぶ。
      // 図だけの表示（view_diagram）では渡さない（線を押せない扱いにし、線の上からも見る場所を動かせるように）
      onEdgeClick={
        props.embed
          ? undefined
          : (ev, e) => {
              if (placing === "LINK" && editable) return;
              // 置く場所を選んでいる間は、線の上を押しても、そこに置く（何もないところを押したときと同じ）
              if (placing && placing !== "LINK" && editable) return placeAt(placing, flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY }));
              const g = e.data?.g;
              if (g?.kind !== "link") return onSelect(g?.element);
              const [from, to] = [elementOf(g.source), elementOf(g.target)];
              if (from && to) props.onSelectLink?.({ from, to });
            }
      }
      onPaneClick={(e) => {
        // 線の両端を選んでいる間に何もないところを押したら、線を引くのをやめる
        if (!placing || !editable) return onSelect(undefined);
        if (placing !== "LINK") placeAt(placing, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        else setPlacing(undefined);
      }}
    >
      <FitOnChange
        modelName={props.modelName}
        layoutKey={nodeIds}
        nodes={graph.nodes}
        embed={props.embed}
        badge={!!props.loop}
        legend={areas.length > 0}
        groupIds={groupIds}
        keepView={props.keepView}
        holdView={props.holdView}
        toolsSpace={!!props.valueTools?.on}
      />
      <Background gap={20} size={1} />
      {/* フローの端をドラッグしている間、弁からマウスまでの線 */}
      {grab && (
        <ViewportPortal>
          <svg className="flow-end-drag" width={1} height={1} aria-hidden>
            <line x1={grab.valve.x} y1={grab.valve.y} x2={grab.at.x} y2={grab.at.y} />
          </svg>
        </ViewportPortal>
      )}
      {props.loop && <LoopBadge loop={props.loop} belowTools={!!props.onEditableChange} onClose={props.onLoopClose} />}
      {areas.length > 0 && <GroupLegend areas={areas} />}
      {props.onEditableChange && (
        <EditTools
          editable={!!editable}
          onEditableChange={props.onEditableChange}
          placing={placing}
          linkFrom={linkFrom}
          onPlace={setPlacing}
          canAddNote={!!props.onAddNote}
          removable={props.removable}
          onRemove={props.onRemove}
        />
      )}
      {(props.valueTools || props.paneTools || props.onExport) && (
        <Panel position="top-right" className="top-right-tools">
          {props.valueTools && <ValueToolsPanel {...props.valueTools} />}
          {props.onExport && <ExportButton onExport={props.onExport} dropSelection={!loop && !!(linkEdge || selected)} edges={graph.edges.length} />}
          {props.paneTools}
        </Panel>
      )}
      {props.formula && <FormulaCard formula={props.formula} nodes={placed} />}
      {!props.embed && <Controls showInteractive={false} fitViewOptions={props.valueTools?.on ? VIEWER_TOOLS_FIT : VIEWER_FIT} />}
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
  canAddNote,
  removable,
  onRemove,
}: {
  editable: boolean;
  onEditableChange(on: boolean): void;
  placing?: Placing;
  linkFrom?: string;
  onPlace(type: Placing | undefined): void;
  canAddNote: boolean;
  removable?: Removable;
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
            : "図の形を変えられるようにします（要素や注釈を動かす・足す・消す、線を引く、フローの端をつなぎ替える）。値やシナリオは、オフのままでもいつでも直せます"
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
          {canAddNote && (
            <button
              className={`edit-tool ${placing === "NOTE" ? "on" : ""}`}
              aria-pressed={placing === "NOTE"}
              onClick={() => onPlace(placing === "NOTE" ? undefined : "NOTE")}
              title="注釈（どこにもつながらない文字だけのもの）を足します。押してから、図の置きたい場所を押します。文字は左の「編集」で直します"
            >
              ＋注釈
            </button>
          )}
          <button
            className="edit-tool danger"
            disabled={!removable}
            onClick={() => removable && onRemove?.()}
            title={
              removable
                ? removable.link
                  ? `リンク「${removable.label}」を消します（Delete キー）`
                  : removable.note
                    ? `注釈「${removable.label}」を消します（Delete キー）`
                    : `「${removable.label}」を消します（つながるリンクも消えます。Delete キー）`
                : "図で要素か線（リンク）、注釈を選ぶと、消せます"
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

/**
 * 「値を表示」の切り替えと、値を出すシナリオの選択（図の右上）。オンの間は、いまどの時点の値を出しているかを左に添える。
 * 図の左上の編集の道具とは反対の角に置く
 */
function ValueToolsPanel({ on, onChange, scenarios, baseline, scenario, onScenario, caption }: ValueTools) {
  return (
    <div className={`value-tools ${on ? "on" : ""}`}>
      {on && <span className="value-caption">{caption}</span>}
      {on && scenarios.length > 0 && (
        <select
          className="value-scenario"
          aria-label="値を出すシナリオ"
          title="どのシナリオの値を出すかを選びます。変化は、そのシナリオの中の最初の時点と比べます"
          value={scenario ?? ""}
          onChange={(e) => onScenario(e.target.value === "" ? undefined : e.target.value)}
        >
          <option value="">{baseline}</option>
          {scenarios.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
      <button
        className={`edit-toggle ${on ? "on" : ""}`}
        onClick={() => onChange(!on)}
        aria-pressed={on}
        title={
          on
            ? "図の要素の値を隠します"
            : "ストック・フロー・変数に、その時点の値と最初の時点からの変化を出します。グラフにカーソルを乗せるとその時刻の値、乗せていなければそれぞれの最大の振れを出します"
        }
      >
        値を表示
      </button>
    </div>
  );
}

/**
 * 図の「書き出す」（図の右上）。図だけを SVG と PNG（2 倍の解像度）にして渡す。書き出している間は押せない。
 * 「広げる」と並ぶので、記号だけにする（言葉は title と aria-label に出す）
 */
function ExportButton({ onExport, dropSelection, edges }: { onExport(create: () => Promise<ExportedDiagram>): Promise<void>; dropSelection: boolean; edges: number }) {
  const domNode = useStore((s) => s.domNode);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!domNode || busy) return;
    setBusy(true);
    try {
      await onExport(() => exportDiagram(domNode, { scale: 2, dropSelection, edges }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className="edit-toggle expand-button"
      onClick={() => void run()}
      disabled={busy}
      aria-label="図を画像に書き出す"
      title="図だけを SVG（拡大してもぼやけない）と PNG（2 倍の解像度）に書き出します。資料に貼る用です。いま見ている表示のまま（「値を表示」の値も入ります）、白い背景の明るい配色で、図全体を書き出します。保存先は作業フォルダの exports/<モデル名>/ です"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 11v2.5h11V11" />
      </svg>
    </button>
  );
}

/** 式の箱と選んだ箱のあいだ（画面の px） */
const FORMULA_GAP = 12;
/** 式の箱と図の欄の縁のあいだ（はみ出すときに寄せる） */
const FORMULA_MARGIN = 8;
/** 箱の下に出す「値を表示」の値の高さの目安。下に置くときは、その下に出す */
const LIVE_VALUE_SPACE = 22;

/**
 * 選んだ要素の式に値を入れたもの。図を動かしたり拡大したりしても、選んだ箱の横についていく（字の大きさは変えない）。
 * 右・左・上・下のうち、ほかの箱と重なる面積と図の欄からはみ出す面積がいちばん小さい側に置く（同じなら右を先に選ぶ）。
 * マウスは通す（下の要素や背景を押せるように）
 */
function FormulaCard({ formula, nodes }: { formula: SelectedFormula; nodes: GraphNode[] }) {
  const [tx, ty, zoom] = useStore((s) => s.transform);
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const ref = useRef<HTMLDivElement>(null);
  // 式の箱の大きさ（描いてから測る。測るまでは見せない）。幅は中身で決まり（.formula-card の width: max-content）、置く場所によらない。
  // 中身や図の欄の幅（幅の上限）が変わったら測り直す
  const [size, setSize] = useState<{ w: number; h: number }>();
  // そろえた形が箱の幅に収まらなかった式（幅の目安より字が広いとき）。一覧の形で出し直す。
  // 時点が変わって値だけが変わっても一覧のままにする（カーソルを動かすたびに形が変わらないように）
  const [overflowed, setOverflowed] = useState<string>();
  const { view, caption, hint } = formula;
  const formulaKey = `${view.name}=${formulaText(view.tokens)}`;
  const layout = view.layout === "list" || overflowed === formulaKey ? "list" : "aligned";
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    const grid = el.querySelector<HTMLElement>(".formula-grid");
    if (grid && grid.scrollWidth > grid.clientWidth + 1) setOverflowed(formulaKey);
  }, [formulaKey]);
  useLayoutEffect(measure, [measure, view, caption, hint, layout]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const target = nodes.find((n) => n.element && nameKey(n.element) === nameKey(formula.element));
  if (!target) return null;
  const box = { x: target.x * zoom + tx, y: target.y * zoom + ty, w: target.width * zoom, h: target.height * zoom };
  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const candidates = [
    { x: box.x + box.w + FORMULA_GAP, y: box.y + box.h / 2 - h / 2 },
    { x: box.x - FORMULA_GAP - w, y: box.y + box.h / 2 - h / 2 },
    { x: box.x + box.w / 2 - w / 2, y: box.y - FORMULA_GAP - h },
    { x: box.x + box.w / 2 - w / 2, y: box.y + box.h + LIVE_VALUE_SPACE + FORMULA_GAP },
  ];
  const others = nodes.filter((n) => n !== target).map((n) => ({ x: n.x * zoom + tx, y: n.y * zoom + ty, w: n.width * zoom, h: n.height * zoom }));
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const pane = { x: 0, y: 0, w: width, h: height };
  const cost = (c: { x: number; y: number }) => {
    const r = { ...c, w, h };
    return others.reduce((sum, o) => sum + overlap(r, o), 0) + (w * h - overlap(r, pane)) * 2;
  };
  const side = candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  // どの側でもはみ出すときは、図の欄の中に寄せる（読めなくなるよりは、箱に少し重なるほうがよい）
  const clamp = (v: number, max: number) => Math.max(FORMULA_MARGIN, Math.min(v, max - FORMULA_MARGIN));
  const best = { x: clamp(side.x, width - w), y: clamp(side.y, height - h) };
  return (
    <div
      ref={ref}
      className={`formula-card ${layout === "list" ? "is-list" : ""}`}
      style={{ left: best.x, top: best.y, visibility: size ? undefined : "hidden" }}
      aria-label={`${view.name}の式と値`}
    >
      <div className="formula-caption">{caption}</div>
      {layout === "aligned" ? <AlignedFormula view={view} /> : <FormulaList view={view} />}
      {view.note && <div className="formula-note">{view.note}</div>}
      {hint && <div className="formula-note">{hint}</div>}
    </div>
  );
}

/** 式の片の、下の行に出すもの。参照はその時点の値（時間をまたぐ関数に渡す参照は名前のまま）、それ以外は上の行と同じ */
function tokenValue(t: FormulaToken) {
  if (t.kind !== "ref") return <span className={`formula-${t.kind}`}>{t.text}</span>;
  if (t.held || t.value === undefined) return <span className="formula-held" title={t.held ? "過去の値を使うので、いまの値は入れません" : "値がありません"}>{t.text}</span>;
  return <span className="formula-value">{t.value}</span>;
}

/** 上の行に式、下の行に同じ並びで値を入れたもの。片ごとに列をそろえる */
function AlignedFormula({ view }: { view: FormulaView }) {
  // 決まった値の変数（式が数だけ）や、フローが出入りしないストックは、左辺の値だけ
  if (!view.tokens.length)
    return (
      <div className="formula-list-head">
        <span className="formula-lhs">{view.name}</span> = <span className="formula-lhs-value">{view.value}</span>
      </div>
    );
  const cols = view.tokens.length + 2;
  return (
    <div className="formula-grid" style={{ gridTemplateColumns: `repeat(${cols}, auto)` }}>
      <span className="formula-lhs">{view.name}</span>
      <span>=</span>
      {view.tokens.map((t, i) => (
        <span key={i} className={t.kind === "ref" ? "formula-ref" : `formula-${t.kind}`}>
          {t.text}
        </span>
      ))}
      <span className="formula-lhs-value">{view.value}</span>
      <span>=</span>
      {view.tokens.map((t, i) => (
        <span key={`v${i}`}>{tokenValue(t)}</span>
      ))}
    </div>
  );
}

/** 式が長いとき：上に左辺の値と式、下に参照ごとの値の一覧 */
function FormulaList({ view }: { view: FormulaView }) {
  return (
    <>
      <div className="formula-list-head">
        <span className="formula-lhs">{view.name}</span> = <span className="formula-lhs-value">{view.value}</span>
      </div>
      <div className="formula-text">= {formulaText(view.tokens)}</div>
      <ul className="formula-refs">
        {view.refs.map((r) => (
          <li key={r.name}>
            {r.name} = <span className={r.held ? "formula-held" : "formula-value"}>{r.value}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * 目立たせているループの名前と R / B。名前を付けたループには、記号（R1 など）を小さく添える。
 * 作業画面では、左上の「図を編集」と重ならないよう、その下に出す（書き出す画像では、札はいつも図の上に置く）。
 * onClose を渡すと（作業画面）、やめるための ✕ を札の右上の角に出す。✕ は札の大きさに入れず、書き出す画像にも入れない
 */
function LoopBadge({ loop, belowTools, onClose }: { loop: LoopView; belowTools?: boolean; onClose?(): void }) {
  return (
    <Panel position="top-left" className={`loop-badge loop-${loop.kind.toLowerCase()}${belowTools ? " below-tools" : ""}`}>
      <span className="loop-kind" aria-hidden>
        {loop.kind === "unknown" ? "?" : loop.kind}
      </span>
      <span className="loop-text">
        <span className="loop-name">{loop.name}</span>
        {loop.name !== LOOP_KIND_LABEL[loop.kind] && <span className="loop-kind-label">{loop.symbol ? `${loop.symbol}・${LOOP_KIND_LABEL[loop.kind]}` : LOOP_KIND_LABEL[loop.kind]}</span>}
      </span>
      {onClose && (
        <button className="loop-badge-close" data-export="skip" onClick={onClose} aria-label={`ループ「${loop.name}」を目立たせるのをやめる`} title="ループを目立たせるのをやめます">
          ✕
        </button>
      )}
    </Panel>
  );
}

const FIT_PADDING = 0.15;
// 毎回作り直すと React Flow が合わせ直しの途中の設定を上書きするので、ここで 1 度だけ作る
const EMBED_FIT = { padding: 0.04, maxZoom: 1.5 };
/** ループの札（左上）の分だけ、上を空ける。図だけの表示で、札が図に重ならないように */
const BADGE_SPACE = "76px" as const;
const EMBED_LOOP_FIT = { padding: { top: BADGE_SPACE, bottom: 0.04, x: 0.04 }, maxZoom: 1.5 };
/** グループの凡例（下の真ん中）の分だけ、下を空ける。図だけの表示で、凡例が図に重ならないように */
const LEGEND_SPACE = "48px" as const;
const EMBED_LEGEND_FIT = { padding: { top: 0.04, bottom: LEGEND_SPACE, x: 0.04 }, maxZoom: 1.5 };
const EMBED_LOOP_LEGEND_FIT = { padding: { top: BADGE_SPACE, bottom: LEGEND_SPACE, x: 0.04 }, maxZoom: 1.5 };
const VIEWER_FIT = { padding: FIT_PADDING, maxZoom: 1.5, minZoom: MIN_FIT_ZOOM };
/**
 * 「値を表示」がオンの間は、右上の道具（シナリオの選択を出すと横に長くなる）の分だけ上を空ける。
 * 図を合わせたとき、右上の要素が道具の下に隠れて押せなくならないように
 */
const TOOLS_SPACE = "56px" as const;
const VIEWER_TOOLS_PADDING = { top: TOOLS_SPACE, bottom: FIT_PADDING, x: FIT_PADDING };
const VIEWER_TOOLS_FIT = { ...VIEWER_FIT, padding: VIEWER_TOOLS_PADDING };

/**
 * 線を押せる幅（React Flow の既定は 20px）。線の上からは見る場所を動かせないので、細めにして、図をドラッグしやすくする
 */
const EDGE_HIT = 10;

/** フローの端のつまみを、端から弁の側にどれだけ寄せるか（要素の縁の、リンクを引き始める口より外に出す） */
const GRIP_OFFSET = 14;
/** フローの矢じりの長さ（markerEnd の大きさ） */
const ARROW_SIZE = 12;

/** リンクを引いている間の線。図のリンクと同じ色と点線にする */
const CONNECTION_LINE = { stroke: "var(--link)", strokeWidth: 1.5, strokeDasharray: "5 4" };

/** 図のリンクの線が、両端の要素名の組と同じか（大文字と小文字は区別しない） */
function sameLink(graph: Graph, e: GraphEdge, l: LinkEnds): boolean {
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.element ?? "";
  return nameKey(name(e.source)) === nameKey(l.from) && nameKey(name(e.target)) === nameKey(l.to);
}

/** 「値を表示」で値を出す要素の種類（ストック・フロー（弁）・変数。変換器も変数と同じく出す） */
const LIVE_KINDS = new Set(["STOCK", "VALVE", "VARIABLE", "CONVERTER"]);
const liveOf = (live: NodeValues, element: string) => {
  const v = live.values.get(nameKey(element));
  return v && { v, unit: live.unit };
};

const miniMapColor = (n: DiagramNodeT) =>
  n.type !== "model" ? "transparent" : n.data.g.kind === "STOCK" ? "var(--stock-border)" : n.data.g.kind === "NOTE" ? "var(--note-border)" : "var(--link)";

/**
 * 表示範囲を合わせ直す。別のモデルを開いたとき、配置を切り替えたとき、要素が増減したとき、図の欄の大きさが変わったとき。
 * 式や値が変わっただけのとき（AI が値を調整したなど）は動かさない。画面で要素を足した・消した・名前を変えたとき（keepView）も、増減では動かさない。
 * 境界線のドラッグや、図かグラフ・表を広げた・戻したことで図の欄の大きさが変わったとき（holdView）も動かさない（ズームや位置を保つ）。
 * 図の欄を隠している間（グラフ・表を広げている）に合わせ直すことになったら（別のモデルを開いた、要素が増減したなど）、次に見えたときに合わせる。
 * 全体が名前の読める大きさで入らないときは、ストックが入るように合わせる（ほかはドラッグやミニマップで見る）。
 * 「値を表示」をオンにした・オフにしたとき（toolsSpace）も合わせ直す。オンの間は、右上の道具の分だけ上を空ける。
 */
function FitOnChange({
  modelName,
  layoutKey,
  nodes,
  embed,
  badge,
  legend,
  groupIds,
  keepView,
  holdView,
  toolsSpace,
}: {
  modelName: string;
  layoutKey: string;
  nodes: GraphNode[];
  embed?: boolean;
  badge?: boolean;
  /** 図の下にグループの凡例を出している（図だけの表示では、その分だけ下を空ける） */
  legend?: boolean;
  /** グループの囲みのノードの ID。全体を入れるときは、囲みも入れる */
  groupIds?: string[];
  keepView?: boolean;
  holdView?: boolean;
  toolsSpace?: boolean;
}) {
  const flow = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  // 要素の並び（layoutKey）と、それ以外（モデル、図の欄の大きさ）を分けて覚える
  const view = `${modelName}:${Math.round(width / 40)}:${Math.round(height / 40)}:${toolsSpace ? "tools" : ""}`;
  const domNode = useStore((s) => s.domNode);
  const last = useRef({ view, layoutKey, modelName });
  // 境界線のドラッグで変わった大きさが、まだ届いていないか（届くのはドラッグを終えたあとのこともある）
  const held = useRef(false);
  // 図の欄を隠している間に、合わせ直すことになったか
  const fitLater = useRef(false);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const groupIdsRef = useRef(groupIds);
  groupIdsRef.current = groupIds;
  useEffect(() => {
    const prev = last.current;
    last.current = { view, layoutKey, modelName };
    if (holdView) held.current = true;
    const hold = held.current;
    // ドラッグを終え、図の欄のいまの大きさが届いたら、ふだんどおりに戻す
    if (!holdView && domNode && domNode.offsetWidth === width && domNode.offsetHeight === height) held.current = false;
    const visible = !domNode || (domNode.checkVisibility?.() ?? true);
    if (!(fitLater.current && visible)) {
      if (hold && prev.modelName === modelName && prev.layoutKey === layoutKey) return;
      if (prev.view === view && (prev.layoutKey === layoutKey || keepView)) return;
    }
    // 隠れている間は、要素の大きさも図の欄の大きさも測れないので、見えてから合わせる
    fitLater.current = !visible;
    if (!visible) return;
    if (embed) {
      const padding = badge || legend ? { top: badge ? BADGE_SPACE : FIT_PADDING, bottom: legend ? LEGEND_SPACE : FIT_PADDING, x: FIT_PADDING } : FIT_PADDING;
      requestAnimationFrame(() => flow.fitView({ padding, maxZoom: 1.5, duration: 200 }));
      return;
    }
    // 全体が名前の読める大きさで入らなければ、ストックが入るように合わせる
    const fit = fitTargets(nodesRef.current, width, height, FIT_PADDING);
    const targets = fit.nodes.map((n) => ({ id: n.id }));
    if (fit.nodes === nodesRef.current) targets.push(...(groupIdsRef.current ?? []).map((id) => ({ id })));
    const padding = toolsSpace ? VIEWER_TOOLS_PADDING : FIT_PADDING;
    requestAnimationFrame(() => flow.fitView({ nodes: targets, padding, maxZoom: fit.maxZoom, minZoom: MIN_FIT_ZOOM, duration: 200 }));
  }, [view, layoutKey, modelName, keepView, holdView, domNode, flow, embed, badge, legend, width, height, toolsSpace]);
  return null;
}
