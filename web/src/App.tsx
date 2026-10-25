import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AnnotationPatch, ChangeEvent, ElementPatch, GroupPatch, ModelElement, ModelListResponse, ModelResponse, ScenarioPatch } from "../../src/viewer/api.js";
import { FetchError, fetchList, fetchModel, postDiagramExport, postEdit, postGroups, postRemove, postScenarios, postUndo, type WriteResult } from "./api.js";
import { Chart, formatTime, formatValue, scenarioColor, TIME_UNIT_LABEL } from "./Chart.js";
import { Details, DelayToggle } from "./Details.js";
import { Diagram, type LinkEnds, type NodeValues, type Removable, type ScenarioMarks, type SelectedFormula, type ValueTools } from "./Diagram.js";
import { blobToBase64, exportDiagram, type ExportedDiagram } from "./diagramExport.js";
import { nodeValues, peakIndex, timeIndex, valueScenarioNames, valueScenarioRun } from "./diagramValues.js";
import { formulaView } from "./formulaValues.js";
import { InfoTip } from "./InfoTip.js";
import { addElementPatches, addNotePatches, linkProblem, linkRemoveProblem, reconnectChanges, renamedName, type FlowEnd, type NewElementType } from "./editing.js";
import { toGraph } from "../../src/core/diagram.js";
import { LOOP_KIND_LABEL, type LoopView } from "../../src/core/loops.js";
import { annotationsOf, findLink, sameName } from "../../src/core/modeljson.js";
import { hasDelayMark } from "../../src/core/delay.js";
import { countProblems, describeProblemCount, listProblems, stripCount } from "./problemList.js";
import { Problems } from "./Problems.js";
import { ModelTree } from "./ModelTree.js";
import { NoteDetails } from "./NoteDetails.js";
import { folderKey, foldersOf, modelHash, modelTree } from "./modelList.js";
import { GroupPanel } from "./GroupPanel.js";
import { ScenarioEditor } from "./ScenarioEditor.js";
import { clearValuePatches, findScenario, scenarioBadges } from "./scenarios.js";
import { draggedResultsRatio, parseExpandedPane, parseResultsRatio, RESULTS_RATIO, type ExpandedPane } from "./split.js";

// 画面全体：左にモデル一覧と選んだ要素の詳しい情報、右に図とグラフ。
// サーバーからの変更の知らせ（Server-Sent Events）で、開いているモデルを取り直す。
// 画面からの編集（式などの変更、位置の変更、シナリオの変更、元に戻す）はサーバーに送り、同じファイルに書き戻す。
// 図の形を変える操作（配置のドラッグ、要素や注釈を足す・消す、線を引く・消す）は、図の左上の「図を編集」をオンにしたときだけできる。
// 値（詳細欄の「編集」）やシナリオは、「図を編集」に関係なく、いつでも直せる（入力欄に打ち込む操作で、元に戻すでも戻せるため）。

const nameFromHash = () => decodeURIComponent(location.hash.replace(/^#/, ""));

/** ?view=diagram なら図だけを出す（MCP の view_diagram がヘッドレスのブラウザで画像にする） */
const EMBED = new URLSearchParams(location.search).get("view") === "diagram";

/** 図だけの表示で目立たせるループ（?loop= に { name, kind, elements } の JSON。MCP の view_diagram が渡す） */
function loopFromQuery(): LoopView | undefined {
  const text = new URLSearchParams(location.search).get("loop");
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as LoopView;
    return Array.isArray(v.elements) && typeof v.name === "string" && Object.hasOwn(LOOP_KIND_LABEL, v.kind) ? v : undefined;
  } catch {
    return undefined;
  }
}
const EMBED_LOOP = EMBED ? loopFromQuery() : undefined;

/**
 * 図だけの表示で、図を SVG と PNG にする（MCP の export_diagram がヘッドレスのブラウザから呼ぶ）。
 * ビューアの図の「書き出す」ボタンと同じ処理で、PNG は base64 で返す
 */
/** 図だけの表示で描いている図の線の数（書き出す前に、線が描き終わるのを待つため） */
let embedEdges = 0;
if (EMBED) {
  (window as unknown as { loopsightExportDiagram: (scale?: number) => Promise<unknown> }).loopsightExportDiagram = async (scale = 2) => {
    const root = document.querySelector<HTMLElement>(".embed-diagram .react-flow");
    if (!root) throw new Error("図が見つかりません。");
    await document.fonts.ready;
    const image = await exportDiagram(root, { scale, edges: embedEdges });
    return { svg: image.svg, width: image.width, height: image.height, scale: image.scale, png: await blobToBase64(image.png) };
  };
}

/** 前の版と比べて、変わった（または増えた）要素の名前（小文字） */
function changedElements(prev: ModelResponse | undefined, next: ModelResponse): Set<string> {
  const out = new Set<string>();
  if (!prev || prev.name !== next.name) return out;
  const key = (e: ModelElement) => (e.type === "LINK" ? `${e.from} → ${e.to}` : e.name ?? "").toLowerCase();
  const before = new Map(prev.model.elements.map((e) => [key(e), JSON.stringify({ ...e, display: undefined })]));
  for (const e of next.model.elements) {
    if (before.get(key(e)) !== JSON.stringify({ ...e, display: undefined })) out.add(key(e));
  }
  return out;
}

/** 順番待ちのあいだに AI などの変更が画面に出たため、送らなかった書き込みの知らせ */
const SKIPPED_MESSAGE = "画面の変更を送る前に、ほかのところ（AI など）でモデルが変わったため、送りませんでした。いまの内容を確かめて、もう一度直してください。";

/** 名前の変わった要素がないとき。いつも同じ配列にして、表示するたびにグラフを描き直させない */
const NO_RENAMES: [string, string][] = [];

/** 両端が同じリンクか（大文字と小文字は区別しない） */
const sameLink = (a: LinkEnds, b: LinkEnds) => sameName(a.from, b.from) && sameName(a.to, b.to);

/** 入力欄で打っているときは、元に戻すのショートカットを横取りしない */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** モデル一覧を開いているか。ブラウザに覚えておく（使えなければ毎回開いた状態） */
const MODELS_OPEN_KEY = "viewer.modelsOpen";
function loadModelsOpen(): boolean {
  try {
    return localStorage.getItem(MODELS_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function saveModelsOpen(open: boolean) {
  try {
    localStorage.setItem(MODELS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // 覚えられなくても動く
  }
}

/** 左の欄を開いているか。ブラウザに覚えておく（使えなければ毎回開いた状態） */
const SIDEBAR_OPEN_KEY = "viewer.sidebarOpen";
function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function saveSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
  } catch {
    // 覚えられなくても動く
  }
}

/** モデルの一覧で開いているフォルダ（folderKey の並び）。ブラウザに覚えておく（使えなければ毎回閉じた状態） */
const OPEN_FOLDERS_KEY = "viewer.openFolders";
function loadOpenFolders(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
function saveOpenFolders(open: Set<string>) {
  try {
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...open]));
  } catch {
    // 覚えられなくても動く
  }
}

/** 開いているモデルのファイルが、ほかから動かされたり消されたりしたときの知らせ */
const goneMessage = (name: string) => `モデル "${name}" のファイルが見つかりません。動かされたか、消された可能性があります。左の欄の「モデル」の一覧から選び直してください。`;

/** 図の要素に値を出すか（図の欄の「値を表示」）。ブラウザに覚えておく（使えなければ毎回オフ） */
const SHOW_VALUES_KEY = "viewer.diagramValues";
function loadShowValues(): boolean {
  try {
    return localStorage.getItem(SHOW_VALUES_KEY) === "1";
  } catch {
    return false;
  }
}
function saveShowValues(on: boolean) {
  try {
    localStorage.setItem(SHOW_VALUES_KEY, on ? "1" : "0");
  } catch {
    // 覚えられなくても動く
  }
}

/** 下の欄（グラフ・表）の高さの割合。境界線のドラッグで変え、ブラウザに覚えておく（使えなければ毎回はじめの高さ） */
const RESULTS_RATIO_KEY = "viewer.resultsRatio";
function loadResultsRatio(): number {
  try {
    return parseResultsRatio(localStorage.getItem(RESULTS_RATIO_KEY));
  } catch {
    return RESULTS_RATIO;
  }
}
function saveResultsRatio(ratio: number) {
  try {
    localStorage.setItem(RESULTS_RATIO_KEY, String(ratio));
  } catch {
    // 覚えられなくても動く
  }
}

/** 右側いっぱいに広げている欄（図かグラフ・表）。ブラウザに覚えておく（使えなければ毎回上下に分けた形） */
const EXPANDED_PANE_KEY = "viewer.expandedPane";
function loadExpandedPane(): ExpandedPane {
  try {
    return parseExpandedPane(localStorage.getItem(EXPANDED_PANE_KEY));
  } catch {
    return undefined;
  }
}
function saveExpandedPane(pane: ExpandedPane) {
  try {
    localStorage.setItem(EXPANDED_PANE_KEY, pane ?? "none");
  } catch {
    // 覚えられなくても動く
  }
}

/**
 * 図やグラフ・表の「広げる」。押すと右側いっぱいに広げ（もう片方は見出しだけの帯になる）、広げているときに押すと上下に分けた形に戻す。
 * グラフ・表の上の帯の凡例を狭めないよう、記号だけにする（外向きの矢印が広げる、内向きが戻す）。言葉は title と aria-label に出す
 */
function ExpandButton({ pane, expanded, onChange, className }: { pane: "diagram" | "results"; expanded: ExpandedPane; onChange(pane: ExpandedPane): void; className: string }) {
  const on = expanded === pane;
  const name = pane === "diagram" ? "図" : "グラフ・表";
  const other = pane === "diagram" ? "グラフ・表" : "図";
  return (
    <button
      className={`${className} expand-button`}
      onClick={() => onChange(on ? undefined : pane)}
      aria-label={on ? "上下に分けた形に戻す" : `${name}を広げる`}
      title={on ? "図とグラフ・表を上下に分けた形に戻します" : `${name}を右側いっぱいに広げます。${other}は見出しだけの細い帯になります（帯を押すと戻ります）`}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={on ? "M6 2v4H2M2 2l4 4M10 14v-4h4M14 14l-4-4" : "M10 2h4v4M14 2 9 7M6 14H2v-4M2 14l5-5"} />
      </svg>
    </button>
  );
}

export function App() {
  const [list, setList] = useState<ModelListResponse>();
  const [current, setCurrent] = useState(nameFromHash());
  const [data, setData] = useState<ModelResponse>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<string>();
  // 図で線を押して選んだリンク。要素を選ぶと外す
  const [selectedLink, setSelectedLink] = useState<LinkEnds>();
  // 図で押して選んだ注釈の id。要素やリンクを選ぶと外す
  const [selectedNote, setSelectedNote] = useState<string>();
  // 左の欄で説明を直しているシナリオ（名前・値・足す・消すは、シナリオの中身の表で直す）。
  // id は欄を開いた回ごとの番号。表で名前を変えても同じ欄のまま（書きかけの説明を残す）にするため、欄の key に使う
  const [scenario, setScenario] = useState<{ name: string; id: number }>();
  const scenarioSeq = useRef(0);
  // 左の欄を開いているか（たたむと、右の図とグラフを広く使える）。ブラウザに覚えておき、開き直したときも同じ状態から始める。
  // 画面の幅では自動で開け閉めしない（狭い画面で縦に並べるときは、CSS でたたまずに出す）
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  useEffect(() => saveSidebarOpen(sidebarOpen), [sidebarOpen]);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  // ボタンや帯で開け閉めしたら、押したものは隠れるので、もう一方にフォーカスを移す（自動で開いたときは移さない）
  const moveSidebarFocus = useRef(false);
  const toggleSidebar = (open: boolean) => {
    moveSidebarFocus.current = true;
    setSidebarOpen(open);
  };
  // たたんだ帯に出す「問題」の件数（左の欄の「問題」の一覧と同じものを数える）
  const problemCount = useMemo(() => (data ? countProblems(listProblems(data)) : { errors: 0, warnings: 0 }), [data]);
  const problemText = describeProblemCount(problemCount);
  useEffect(() => {
    if (!moveSidebarFocus.current) return;
    moveSidebarFocus.current = false;
    (sidebarOpen ? collapseRef : stripRef).current?.focus();
  }, [sidebarOpen]);
  /** 左の欄でシナリオの説明を直す。同じシナリオの欄を開いていれば、そのままにする。左の欄をたたんでいれば開く */
  const editScenarioDescription = useCallback((name: string) => {
    setScenario((s) => (s && sameName(s.name, name) ? s : { name, id: ++scenarioSeq.current }));
    setSidebarOpen(true);
  }, []);
  // グラフの上のシナリオの凡例にカーソルを乗せているシナリオ
  const [hoveredScenario, setHoveredScenario] = useState<string>();
  // 図の要素に値を出すか（ふだんはオフ。分析や説明のときだけオンにする）
  const [showValues, setShowValuesState] = useState(loadShowValues);
  const setShowValues = useCallback((on: boolean) => {
    setShowValuesState(on);
    saveShowValues(on);
  }, []);
  // 図に値を出すシナリオ（undefined は「元のモデル」）
  const [valuesScenario, setValuesScenario] = useState<string>();
  // グラフにカーソルを乗せている時刻（図に値を出している間だけ受け取る）
  const [hoverTime, setHoverTime] = useState<number>();
  const [changed, setChanged] = useState<Set<string>>(new Set());
  // いま出している版で名前の変わった要素（画面で名前を変えた・元に戻したとき）。グラフに出す要素を新しい名前に合わせる
  const [renamed, setRenamed] = useState<[string, string][]>(NO_RENAMES);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [busy, setBusy] = useState(false);
  // 編集モード（図の左上の「図を編集」。図の形を変える操作をできるようにする）。うっかり動かさないよう、開くたびにオフから始める（ブラウザに覚えさせない）
  const [editMode, setEditMode] = useState(false);
  // 図の形を変えるときは詳細欄を見ながら作業するので、オンにしたら左の欄を開く（オフにしてもたたみ直さない）
  const changeEditMode = useCallback((on: boolean) => {
    setEditMode(on);
    if (on) setSidebarOpen(true);
  }, []);
  // 画面で要素を足した・消した・名前を変えた（元に戻した）あとの版。この版を出している間は、要素が増減しても図の見る場所を合わせ直さない
  const [keepView, setKeepView] = useState<string>();
  // 要素や、シナリオの中身の表の行・シナリオを消したときの知らせ。元に戻したら閉じる
  const removedNotice = useRef<string>(undefined);
  const [modelsOpen, setModelsOpen] = useState(loadModelsOpen);
  const toggleModels = () =>
    setModelsOpen((open) => {
      saveModelsOpen(!open);
      return !open;
    });
  // モデルの一覧で開いているフォルダ
  const [openFolders, setOpenFolders] = useState(loadOpenFolders);
  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      const key = folderKey(path);
      if (!next.delete(key)) next.add(key);
      saveOpenFolders(next);
      return next;
    });
  }, []);
  const tree = useMemo(() => (list ? modelTree(list) : []), [list]);
  // 選んでいるモデルが入っているフォルダは開いておく（閉じたければ、そのあとで閉じられる）
  useEffect(() => {
    const keys = foldersOf(current).map(folderKey);
    if (!keys.length) return;
    setOpenFolders((prev) => {
      if (keys.every((k) => prev.has(k))) return prev;
      const next = new Set([...prev, ...keys]);
      saveOpenFolders(next);
      return next;
    });
  }, [current]);
  // ファイルがなくなったと知らせたモデルの名前。また読めたら外す
  const goneRef = useRef<string>(undefined);
  /**
   * 開いているモデルのファイルがなくなった（ほかから動かされた・消された）。いまの内容は出したままにし、そのことを知らせる。
   * 選び直せるよう、左の欄とモデルの一覧を開く。書き込もうとしても、サーバーが断る（新しいファイルは作らない）。
   * 同じモデルについて知らせ済みなら、開き直さない（exports/ への書き出しなどで読み直すたびに、人が閉じた欄を開かないように）
   */
  const modelGone = useCallback((name: string) => {
    setError(goneMessage(name));
    if (sameModel(goneRef.current, name)) return;
    goneRef.current = name;
    setSidebarOpen(true);
    setModelsOpen(true);
    saveModelsOpen(true);
  }, []);
  const [resultsRatio, setResultsRatio] = useState(loadResultsRatio);
  // 境界線をドラッグしている間（図の欄の大きさが変わっても、図の見る場所を合わせ直さない）
  const [resizing, setResizing] = useState(false);
  const resultsRatioRef = useRef(resultsRatio);
  const [expanded, setExpanded] = useState(loadExpandedPane);
  // 図かグラフ・表を広げた・戻した直後（図の欄の大きさが変わっても、図の見る場所を合わせ直さない）
  const [switchingPane, setSwitchingPane] = useState(false);
  // 図を一度でも出したか。グラフ・表を広げた形で開いたときは、図を出すまで描かない（隠れた欄では、図の表示範囲を合わせられないため）
  const [diagramShown, setDiagramShown] = useState(expanded !== "results");
  const expandPane = (pane: ExpandedPane) => {
    saveExpandedPane(pane);
    setExpanded(pane);
    // はじめて図を出すときは、ページを開いたときと同じように表示範囲を合わせる
    if (pane !== "results" && !diagramShown) setDiagramShown(true);
    else setSwitchingPane(true);
  };
  // 図の欄の大きさが変わった描画のあとで、ふだんどおりに戻す（大きさがあとから届いても、図は合わせ直さない）
  useEffect(() => {
    if (!switchingPane) return;
    const id = requestAnimationFrame(() => setSwitchingPane(false));
    return () => cancelAnimationFrame(id);
  }, [switchingPane]);
  const resizeStart = useRef<{ y: number; results: number; diagram: number; main: number }>(undefined);
  const mainRef = useRef<HTMLElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const endResize = () => {
    if (!resizeStart.current) return;
    resizeStart.current = undefined;
    saveResultsRatio(resultsRatioRef.current);
    setResizing(false);
  };
  const dataRef = useRef<ModelResponse>(undefined);
  const currentRef = useRef(current);
  currentRef.current = current;
  // 読み込みの番号。古い読み込みの結果が、あとから来ても使わない
  const loadSeq = useRef(0);
  // 画面からの書き込みは 1 つずつ順に送る（前の書き込みの新しい版を使うため）
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingWrites = useRef(0);
  // 書き込み中に変更の知らせが来たら、書き込みが終わってから読み直す
  const reloadAfterWrite = useRef(false);
  // ほかのところ（AI など）の変更を画面に出した回数。順番待ちの書き込みは、待っているあいだにこれが増えたら送らない
  const externalSeq = useRef(0);
  const sameModel = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

  const loadList = useCallback(async () => {
    try {
      setList(await fetchList());
    } catch (e) {
      setError(`モデルの一覧を読めません: ${(e as Error).message}`);
    }
  }, []);

  /**
   * 新しい内容を表示する。highlight なら、変わった要素に枠を付ける（ほかで変わったとき）。
   * renames は、前の版から名前の変わった要素。選んでいる要素や線を新しい名前で選んだままにし、図の見る場所も動かさない
   */
  const show = useCallback((next: ModelResponse, highlight: boolean, renames = NO_RENAMES) => {
    // これより前に始めた読み込みの結果は捨てる
    loadSeq.current++;
    if (highlight) externalSeq.current++;
    const diff = highlight ? changedElements(dataRef.current, next) : new Set<string>();
    dataRef.current = next;
    goneRef.current = undefined;
    setData(next);
    setRenamed(renames);
    if (renames.length) {
      setSelected((s) => s && renamedName(s, renames));
      setSelectedLink((l) => l && { from: renamedName(l.from, renames), to: renamedName(l.to, renames) });
      // 名前を変えると図のノードの ID も変わるが、要素は増えも減りもしていないので、見る場所を合わせ直さない
      setKeepView(next.version);
    }
    setError(undefined);
    setUpdatedAt(new Date());
    if (diff.size) {
      setChanged(diff);
      setTimeout(() => setChanged(new Set()), 2500);
    }
  }, []);

  const loadModel = useCallback(
    async (name: string) => {
      if (!name) return;
      if (pendingWrites.current > 0) {
        // 自分の書き込みの知らせかもしれない。書き込みの結果を待ってから確かめる
        reloadAfterWrite.current = true;
        return;
      }
      const seq = ++loadSeq.current;
      try {
        const next = await fetchModel(name);
        if (currentRef.current !== name || seq !== loadSeq.current) return;
        // 読んでいるあいだに画面からの書き込みが始まっていたら、読んだ内容はその書き込みのものかもしれない。
        // 書き込みの結果を待ってから読み直す（自分の変更を AI の変更と取り違えないように）
        if (pendingWrites.current > 0) {
          reloadAfterWrite.current = true;
          return;
        }
        const prev = dataRef.current;
        if (
          prev?.name === next.name &&
          prev.version === next.version &&
          prev.actual?.version === next.actual?.version
        ) {
          // 中身は同じ（画面から書き込んだ結果の知らせなど）。元に戻せる回数だけ変わることがある（サーバーを起動し直したときなど）
          if (prev.undo_available !== next.undo_available) show(next, false);
          // 動かされたモデルが元の場所に戻ったときは、「見つかりません」の知らせを消す
          else if (goneRef.current !== undefined) {
            goneRef.current = undefined;
            setError(undefined);
          }
          return;
        }
        show(next, true);
      } catch (e) {
        // 読めていたモデルのファイルがなくなったときは、なくなったと知らせる（はじめから見つからないときは、サーバーの文をそのまま出す）
        if (e instanceof FetchError && e.status === 404 && sameModel(dataRef.current?.name, name)) modelGone(name);
        else setError(`モデル "${name}" を読めません: ${(e as Error).message}`);
      }
    },
    [show, modelGone],
  );

  // 一覧と変更の知らせ
  useEffect(() => {
    void loadList();
    const es = new EventSource("/api/events");
    // つながり直したら読み直す（切れているあいだの変更は知らせが来ないため）
    let lost = false;
    es.onopen = () => {
      setConnected(true);
      if (lost) {
        lost = false;
        void loadList();
        void loadModel(currentRef.current);
      }
    };
    es.onerror = () => {
      setConnected(false);
      lost = true;
    };
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data as string) as ChangeEvent;
      void loadList();
      // フォルダを作った・消した・動かした。開いているモデルのファイルもなくなったかもしれないので、読み直して確かめる
      if (ev.type === "folders") void loadModel(currentRef.current);
      else if (ev.name.toLowerCase() === currentRef.current.toLowerCase()) {
        if (ev.type === "changed") void loadModel(currentRef.current);
        else modelGone(ev.name);
      }
    };
    const onHash = () => setCurrent(nameFromHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      es.close();
      window.removeEventListener("hashchange", onHash);
    };
  }, [loadList, loadModel, modelGone]);

  // 何も開いていなければ、いちばん最近変わったモデルを開く
  useEffect(() => {
    if (current || !list?.models.length) return;
    const latest = [...list.models].sort((a, b) => b.modified.localeCompare(a.modified))[0]!;
    location.hash = modelHash(latest.name);
  }, [list, current]);

  useEffect(() => {
    dataRef.current = undefined;
    setData(undefined);
    setSelected(undefined);
    setSelectedLink(undefined);
    setSelectedNote(undefined);
    setScenario(undefined);
    setHoveredScenario(undefined);
    setValuesScenario(undefined);
    setNotice(undefined);
    void loadModel(current);
  }, [current, loadModel]);

  /** 書き込みの結果を画面に反映する。失敗したらその文を返す */
  const applyWrite = useCallback(
    (result: WriteResult): string | undefined => {
      // 書き込んでいるあいだに別のモデルを開いていたら、結果は画面に出さない
      const shown = result.ok ? result.data.model.name : result.error.current?.name;
      if (shown && !sameModel(shown, currentRef.current)) return undefined;
      if (result.ok) {
        // 前の知らせ（衝突など）は、利用者が閉じるまで残す
        show(result.data.model, false, result.data.renamed);
        // 書き込めたが知らせたいこと（実際のデータの列名を直せなかったときなど）
        if (result.data.warning) setNotice(result.data.warning);
        return undefined;
      }
      if (result.error.current) {
        // AI などが先に変えていた。最新を出し、変わったところに枠を付ける
        show(result.error.current, true);
        setNotice(result.error.error);
      }
      return result.error.error;
    },
    [show],
  );

  /**
   * 書き込みを順番待ちに入れる。版は、順番が来たときに表示している最新のものを使う。
   * 待っているあいだに AI などの変更が画面に出たら（前の書き込みが衝突したときなど）、送らずに知らせる。
   * 利用者が見ていない内容の上に、黙って書き込まないため。
   */
  const enqueueWrite = useCallback(
    <T,>(task: () => Promise<T>, skipped: T): Promise<T> => {
      pendingWrites.current++;
      setBusy(true);
      const seenExternal = externalSeq.current;
      const guarded = async () => {
        if (externalSeq.current !== seenExternal) return skipped;
        return task();
      };
      const run = writeQueue.current.then(guarded, guarded);
      writeQueue.current = run.catch(() => undefined);
      return run.finally(() => {
        pendingWrites.current--;
        if (pendingWrites.current > 0) return;
        setBusy(false);
        if (reloadAfterWrite.current) {
          reloadAfterWrite.current = false;
          void loadModel(currentRef.current);
        }
      });
    },
    [loadModel],
  );

  /** 要素を直す。notes（注釈の変更）があれば、同じ 1 回の保存で変える */
  const edit = useCallback(
    (elements: ElementPatch[], notes?: AnnotationPatch[]): Promise<string | undefined> =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        return applyWrite(await postEdit(d.name, d.version, elements, notes));
      }, SKIPPED_MESSAGE),
    [applyWrite, enqueueWrite],
  );

  /** シナリオを足す・直す・消す（MCP の set_scenarios と同じ形） */
  const editScenarios = useCallback(
    (patches: ScenarioPatch[], remove?: string[]): Promise<string | undefined> =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        return applyWrite(await postScenarios(d.name, d.version, patches, remove));
      }, SKIPPED_MESSAGE),
    [applyWrite, enqueueWrite],
  );
  /** 図のグループを足す・直す・消す（MCP の set_groups と同じ形） */
  const editGroups = useCallback(
    (patches: GroupPatch[], remove?: string[]): Promise<string | undefined> =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        return applyWrite(await postGroups(d.name, d.version, patches, remove));
      }, SKIPPED_MESSAGE),
    [applyWrite, enqueueWrite],
  );
  /** 左の欄で、シナリオの説明を直す */
  const saveScenarioDescription = useCallback((patch: ScenarioPatch) => editScenarios([patch]), [editScenarios]);
  /**
   * シナリオの中身の表で、シナリオを直す（値、足す・複製する、見出しの吹き出しで名前を変える）。編集欄は開かない。
   * 左の欄で説明を直しているシナリオの名前を変えたら、新しい名前で開いたままにする
   */
  const saveScenarioValue = useCallback(
    (patch: ScenarioPatch): Promise<string | undefined> =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        const result = await postScenarios(d.name, d.version, [patch]);
        const err = applyWrite(result);
        // 名前は、新しい版と同じ描画で差し替える（左の欄が一瞬「見つかりません」になって作り直されないように）
        const to = patch.rename_to;
        if (!err && result.ok && to !== undefined) {
          setScenario((s) => (s && sameName(s.name, patch.name) ? { ...s, name: to } : s));
          // 図に値を出しているシナリオも、新しい名前で選んだままにする
          setValuesScenario((s) => (s !== undefined && sameName(s, patch.name) ? to : s));
        }
        return err;
      }, SKIPPED_MESSAGE),
    [applyWrite, enqueueWrite],
  );
  /**
   * シナリオの中身の表で、行（変える値）を消す。すべてのシナリオでその値を変えないことにする。
   * 確かめずに消す代わりに、すべてのシナリオの変更を 1 回の保存にし（Ctrl+Z 1 回で戻せる）、戻せることを知らせの帯に出す
   */
  const removeScenarioValue = useCallback(
    async (element: string) => {
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 変えているシナリオは、順番が来たときの最新の内容で決める。どのシナリオも変えていなければ（続けて押したときなど）何もしない
        const patches = clearValuePatches(d.model, element);
        if (!patches.length) return undefined;
        const result = await postScenarios(d.name, d.version, patches);
        const err = applyWrite(result);
        if (!err && result.ok) {
          removedNotice.current = `「${element}」の行を消しました（Ctrl+Z で戻せます）`;
          setNotice(removedNotice.current);
        }
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      return err;
    },
    [applyWrite, enqueueWrite],
  );
  /**
   * シナリオの中身の表の見出しの吹き出しで、シナリオを消す。表の行を消すときと同じく、確かめずに消す代わりに、
   * Ctrl+Z で戻せることを知らせの帯に出す。左の欄でそのシナリオの説明を直していたら閉じる
   */
  const removeScenario = useCallback(
    async (name: string) => {
      const model = currentRef.current;
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 続けて押したときなどで、先に消えていれば何もしない
        if (!findScenario(d.model, name)) return undefined;
        const result = await postScenarios(d.name, d.version, [], [name]);
        const err = applyWrite(result);
        if (!err && result.ok) {
          removedNotice.current = `シナリオ「${name}」を消しました（Ctrl+Z で戻せます）`;
          setNotice(removedNotice.current);
        }
        return err;
      }, SKIPPED_MESSAGE);
      if (!err && currentRef.current === model) setScenario((s) => (s && sameName(s.name, name) ? undefined : s));
      return err;
    },
    [applyWrite, enqueueWrite],
  );
  /** 図で要素を選ぶと、シナリオの編集欄を閉じて、その要素を出す */
  const selectElement = useCallback((name: string | undefined) => {
    setScenario(undefined);
    setSelected(name);
    setSelectedLink(undefined);
    setSelectedNote(undefined);
  }, []);
  /** 図で線を押してリンクを選ぶ。要素を選んだときと同じく、シナリオの編集欄を閉じる */
  const selectLink = useCallback((link: LinkEnds) => {
    setScenario(undefined);
    setSelected(undefined);
    setSelectedLink(link);
    setSelectedNote(undefined);
  }, []);
  /** 図で注釈を押して選ぶ。要素を選んだときと同じく、シナリオの編集欄を閉じる */
  const selectNote = useCallback((id: string) => {
    setScenario(undefined);
    setSelected(undefined);
    setSelectedLink(undefined);
    setSelectedNote(id);
  }, []);

  const undo = useCallback(
    () =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !d.undo_available || !sameModel(d.name, currentRef.current)) return undefined;
        const result = await postUndo(d.name, d.version);
        const err = applyWrite(result);
        if (err) setNotice(err);
        else if (result.ok) {
          // 足した・消した要素が戻っても、図の見る場所は動かさない。消したときの知らせは、戻したので閉じる
          setKeepView(result.data.model.version);
          setNotice((n) => (n !== undefined && n === removedNotice.current ? undefined : n));
          // 元に戻してなくなったリンクは、選ぶのをやめる（「見つかりません」と出さないように）
          setSelectedLink((l) => (l && findLink(result.data.model.model, l.from, l.to) ? l : undefined));
        }
        return err;
      }, SKIPPED_MESSAGE).then((err) => {
        if (err === SKIPPED_MESSAGE) setNotice(err);
      }),
    [applyWrite, enqueueWrite],
  );

  // Ctrl+Z（Mac は ⌘Z）で元に戻す
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault();
        void undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  /** 編集モードで、図の at（図の座標）に要素を足し、足した要素を選ぶ。名前は仮の名前で、詳細欄の「編集」で直す */
  const addElement = useCallback(
    async (type: NewElementType, at: { x: number; y: number }) => {
      const model = currentRef.current;
      let added: string | undefined;
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 仮の名前は、順番が来たときの最新の内容で決める（前の書き込みで足した名前と重ねない）
        const { name, patches, notes } = addElementPatches(d.model, toGraph(d.model), type, at);
        const result = await postEdit(d.name, d.version, patches, notes);
        const err = applyWrite(result);
        if (!err && result.ok) {
          added = name;
          setKeepView(result.data.model.version);
        }
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      // 書き込むあいだに別のモデルを開いていたら、選ばない
      else if (added && currentRef.current === model) selectElement(added);
    },
    [applyWrite, enqueueWrite, selectElement],
  );

  /**
   * 編集モードで、要素を消す（つながるリンクも消える）。つながっていたフローは残して、端を雲にする。
   * 消したことでほかに変わったこと（フローの端、式に残った参照、シナリオの値）は、知らせの帯に出す
   */
  const removeElement = useCallback(
    async (name: string) => {
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 同じ要素を続けて消そうとした（キーの押し直し、ボタンの二度押し）ときは、先に消えているので何もしない
        if (!d.model.elements.some((e) => e.type !== "LINK" && e.name?.toLowerCase() === name.toLowerCase())) return undefined;
        const result = await postRemove(d.name, d.version, [{ name }]);
        const err = applyWrite(result);
        if (!err && result.ok) {
          setKeepView(result.data.model.version);
          const notes = result.data.report?.notes;
          if (notes?.length) {
            removedNotice.current = `「${name}」を消しました。${notes.join(" ")}`;
            setNotice(removedNotice.current);
          }
        }
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      else setSelected((s) => (s && s.toLowerCase() === name.toLowerCase() ? undefined : s));
    },
    [applyWrite, enqueueWrite],
  );

  /** 編集モードで、from から to へリンクを引き、引いたリンクを選ぶ。引けないとき（同じ向きのリンクがある、自分自身へなど）は、知らせの帯に理由を出す */
  const addLink = useCallback(
    async (from: string, to: string) => {
      const model = currentRef.current;
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 順番が来たときの最新の内容で確かめる
        const problem = linkProblem(d.model, from, to);
        if (problem) return problem;
        const result = await postEdit(d.name, d.version, [{ type: "LINK", from, to }]);
        const err = applyWrite(result);
        if (!err && result.ok) setKeepView(result.data.model.version);
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      else if (currentRef.current === model) selectLink({ from, to });
    },
    [applyWrite, enqueueWrite, selectLink],
  );

  /**
   * 編集モードで、フローの端をつなぎ替える。to がストックの名前ならそのストックに、図の座標ならそこに置いた雲につなぐ。
   * つなげないとき（ストックでない、両端が同じストックになるなど）は、知らせの帯に理由を出す
   */
  const reconnectFlow = useCallback(
    async (flow: string, end: FlowEnd, to: string | { x: number; y: number }) => {
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 順番が来たときの最新の内容で確かめる
        const changes = reconnectChanges(d.model, toGraph(d.model), flow, end, to);
        if (typeof changes === "string") return changes;
        if (!changes.elements.length && !changes.notes.length) return undefined;
        const result = await postEdit(d.name, d.version, changes.elements, changes.notes);
        const err = applyWrite(result);
        // 雲が増えたり減ったりしても、図の見る場所は動かさない
        if (!err && result.ok) setKeepView(result.data.model.version);
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
    },
    [applyWrite, enqueueWrite],
  );

  /** 編集モードで、リンクを消す。先の要素の式が元の要素を使っているリンクは消さず、知らせの帯に理由を出す */
  const removeLink = useCallback(
    async (link: LinkEnds) => {
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 同じリンクを続けて消そうとしたときは、先に消えているので何もしない
        if (!findLink(d.model, link.from, link.to)) return undefined;
        const problem = linkRemoveProblem(d.model, link.from, link.to);
        if (problem) return problem;
        const result = await postRemove(d.name, d.version, [link]);
        const err = applyWrite(result);
        if (!err && result.ok) setKeepView(result.data.model.version);
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      else setSelectedLink((l) => (l && sameLink(l, link) ? undefined : l));
    },
    [applyWrite, enqueueWrite],
  );

  /**
   * 編集モードで、図の at（図の座標）に注釈を足し、足した注釈を選ぶ。文字は仮の文字で、詳細欄の「編集」で直す
   */
  const addNote = useCallback(
    async (at: { x: number; y: number }) => {
      const model = currentRef.current;
      let added: string | undefined;
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // id は、順番が来たときの最新の内容で決める（前の書き込みで足した id と重ねない）
        const { id, elements, notes } = addNotePatches(d.model, toGraph(d.model), at);
        const result = await postEdit(d.name, d.version, elements, notes);
        const err = applyWrite(result);
        if (!err && result.ok) {
          added = id;
          setKeepView(result.data.model.version);
        }
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      else if (added && currentRef.current === model) selectNote(added);
    },
    [applyWrite, enqueueWrite, selectNote],
  );

  /** 編集モードで、注釈を消す */
  const removeNote = useCallback(
    async (id: string) => {
      const err = await enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        // 続けて消そうとしたときは、先に消えているので何もしない
        if (!annotationsOf(d.model).some((a) => sameName(a.id, id))) return undefined;
        const result = await postRemove(d.name, d.version, [], [id]);
        const err = applyWrite(result);
        if (!err && result.ok) setKeepView(result.data.model.version);
        return err;
      }, SKIPPED_MESSAGE);
      if (err) setNotice(err);
      else setSelectedNote((n) => (n !== undefined && sameName(n, id) ? undefined : n));
    },
    [applyWrite, enqueueWrite],
  );

  /** 図で動かした位置（要素と注釈）を保存する */
  const move = useCallback(
    async (patches: ElementPatch[], notes?: AnnotationPatch[]) => {
      const err = await edit(patches, notes);
      if (err) setNotice(err);
      return err;
    },
    [edit],
  );

  const graph = useMemo(() => (data ? toGraph(data.model) : undefined), [data]);
  const finalValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data?.run?.series ?? {})) out[k] = formatValue(v.at(-1));
    return out;
  }, [data]);
  // 図の札：注目しているシナリオ（凡例にカーソルを乗せているシナリオ、なければ左の欄で直しているシナリオ）で変えた要素に、保存してある値を出す
  // 乗せたまま AI などがシナリオを消したり名前を変えたりして見つからなければ、直しているシナリオに戻す
  const scenarioMarks = useMemo<ScenarioMarks | undefined>(() => {
    if (!data) return undefined;
    const name = [hoveredScenario, scenario?.name].find((n) => n !== undefined && findScenario(data.model, n));
    const s = name !== undefined ? findScenario(data.model, name) : undefined;
    if (name === undefined || !s) return undefined;
    // 色はシナリオの線の色。直しているシナリオが実行できなかった・色が足りずに出していないときは、線がないので灰色にする
    const color = (data.run && scenarioColor(data.run, data.scenarios ?? [], name)) ?? "var(--text-secondary)";
    return { badges: scenarioBadges(data.model, s.values), color };
  }, [data, hoveredScenario, scenario?.name]);
  // 図に値を出すシナリオの実行結果。選んだシナリオが実行できなかった・消されたときは、「元のモデル」に戻す
  const valuesRun = valueScenarioRun(data?.scenarios, valuesScenario);
  useEffect(() => {
    if (valuesScenario !== undefined && data && !valuesRun) setValuesScenario(undefined);
  }, [valuesScenario, data, valuesRun]);
  // 図の要素に出す値。グラフにカーソルを乗せていればその時刻、なければ要素ごとの最大の振れ。AI が実行し直したら、新しい結果で出し直す
  const hoverIndex = showValues && data?.run && hoverTime !== undefined ? timeIndex(data.run.times, hoverTime) : undefined;
  const liveValues = useMemo<NodeValues | undefined>(() => {
    const run = data?.run;
    if (!showValues || !run) return undefined;
    const unit = TIME_UNIT_LABEL[run.time_units.toLowerCase()] ?? run.time_units;
    return { values: nodeValues({ times: run.times, series: valuesRun?.series ?? run.series }, hoverIndex), unit };
  }, [showValues, data, valuesRun, hoverIndex]);
  const valueTools = useMemo<ValueTools>(() => {
    const run = data?.run;
    const unit = run ? (TIME_UNIT_LABEL[run.time_units.toLowerCase()] ?? run.time_units) : "";
    return {
      on: showValues,
      onChange: setShowValues,
      scenarios: valueScenarioNames(data?.scenarios),
      scenario: valuesRun?.name,
      onScenario: setValuesScenario,
      // いまどちらを出しているか（図の欄の上の帯に出す）
      caption: !run ? "実行できないため、値を出せません" : hoverIndex !== undefined ? `${formatTime(run.times[hoverIndex])} ${unit}の値` : "それぞれの最大の振れ",
    };
  }, [data, showValues, setShowValues, valuesRun, hoverIndex]);
  // 選んだ要素の式に、その時点の値を入れたもの（「値を表示」がオンで、要素を選んでいるときだけ）。
  // 時点は図の値と同じ：グラフにカーソルを乗せていればその時刻、なければその要素の最大の振れの時点
  const selectedFormula = useMemo<SelectedFormula | undefined>(() => {
    const run = data?.run;
    if (!showValues || !run || !selected) return undefined;
    const series = valuesRun?.series ?? run.series;
    const own = Object.entries(series).find(([k]) => sameName(k, selected))?.[1];
    const at = hoverIndex ?? (own && peakIndex(own)) ?? 0;
    const view = formulaView(data.model, selected, series, at);
    if (!view) return undefined;
    const unit = TIME_UNIT_LABEL[run.time_units.toLowerCase()] ?? run.time_units;
    // 最大の振れを出しているときは、そう添える（どの時点も同じ値の要素は、時点を出さない）
    const caption =
      hoverIndex !== undefined ? `${formatTime(run.times[at])} ${unit}の値` : own?.every((v) => v === own[0]) ? "どの時点も同じ値" : `${formatTime(run.times[at])} ${unit}の値（最大の振れ）`;
    // ストックの最大の振れの時点は、出入りがほぼ釣り合って増え方が 0 に近いので、ほかの時点の見方を添える
    const stock = data.model.elements.some((e) => e.type === "STOCK" && sameName(e.name, selected));
    const hint = stock && hoverIndex === undefined ? "グラフにカーソルを乗せると、その時点の出入りが見られます" : undefined;
    return { element: selected, view, caption, hint };
  }, [data, showValues, selected, valuesRun, hoverIndex]);
  // 名前は大文字と小文字を区別しない（AI が表記だけ変えても選んだままにする）
  const selectedEl = selected ? data?.model.elements.find((e) => e.name && e.name.toLowerCase() === selected.toLowerCase()) : undefined;
  // 選んでいるリンク（AI などが消していれば、ない）
  const selectedLinkEl = selectedLink && data ? findLink(data.model, selectedLink.from, selectedLink.to) : undefined;
  // 選んでいる注釈（AI などが消していれば、ない）
  const selectedNoteEl = selectedNote !== undefined && data ? annotationsOf(data.model).find((a) => sameName(a.id, selectedNote)) : undefined;
  // 編集モードで消せる要素（足せる種類と同じく、状態と遷移は消さない）か、リンク。
  // シナリオの編集欄を開いている間は、左に出ていない要素を消さないよう、消せないことにする
  const removableName =
    editMode && !scenario && selectedEl && selectedEl.type !== "STATE" && selectedEl.type !== "TRANSITION" ? selectedEl.name : undefined;
  // 先の要素の式が使っているなど、消せないリンクの理由（左の欄に出し、「削除」は押せなくする）
  const linkLocked = selectedLinkEl && data ? linkRemoveProblem(data.model, selectedLinkEl.from!, selectedLinkEl.to!) : undefined;
  const [linkFrom, linkTo] = editMode && !scenario && selectedLinkEl && !linkLocked ? [selectedLinkEl.from!, selectedLinkEl.to!] : [];
  const removableNote = editMode && !scenario ? selectedNoteEl?.id : undefined;
  const removable = useMemo<Removable | undefined>(
    () =>
      removableName
        ? { label: removableName, link: false }
        : linkFrom && linkTo
          ? { label: `${linkFrom} → ${linkTo}`, link: true }
          : removableNote !== undefined
            ? { label: removableNote, link: false, note: true }
            : undefined,
    [removableName, linkFrom, linkTo, removableNote],
  );
  const removeSelected = useCallback(() => {
    if (removableName) void removeElement(removableName);
    else if (linkFrom && linkTo) void removeLink({ from: linkFrom, to: linkTo });
    else if (removableNote !== undefined) void removeNote(removableNote);
  }, [removableName, linkFrom, linkTo, removableNote, removeElement, removeLink, removeNote]);

  // 編集モードで要素かリンクを選んでいるときは、Delete キーで消す。
  // 文字を消すつもりで押されやすい Backspace は使わない。押しっぱなしの繰り返しは無視する。
  // 入力欄で打っているときと、左の欄（詳細欄の編集のボタンなど）にいるときは消さない（打ちかけの内容を失わないように）。
  // 図を帯にしている間（グラフ・表を広げている）も消さない（見えない要素を消さないように）
  const canRemove = !!removable && expanded !== "results";
  useEffect(() => {
    if (!canRemove) return;
    const onKey = (e: KeyboardEvent) => {
      const inSidebar = e.target instanceof Element && !!e.target.closest(".sidebar");
      if (e.key === "Delete" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && !inSidebar) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canRemove, removeSelected]);
  // 図の「書き出す」。画像を作り、サーバーに作業フォルダの exports/<モデル名>/ へ書いてもらう
  const exportDiagramFiles = useCallback(async (create: () => Promise<ExportedDiagram>) => {
    const name = currentRef.current;
    let image: ExportedDiagram;
    try {
      image = await create();
    } catch (e) {
      setNotice(`図を画像にできませんでした: ${(e as Error).message}`);
      return;
    }
    const result = await postDiagramExport(name, image.svg, await blobToBase64(image.png));
    if (!sameModel(name, currentRef.current)) return;
    setNotice(result.ok ? `図を書き出しました：${result.data.files.join("、")}` : `図を書き出せませんでした: ${result.error}`);
  }, []);

  const title = data?.model.name || current;

  if (EMBED) {
    embedEdges = graph?.edges.length ?? 0;
    return (
      <div className="embed-diagram">
        {graph && data ? (
          <ReactFlowProvider>
            <Diagram graph={graph} modelName={data.name} changed={changed} values={finalValues} onSelect={() => undefined} onMove={move} embed loop={EMBED_LOOP} />
          </ReactFlowProvider>
        ) : (
          <p className="muted pad">{error ?? "読み込んでいます…"}</p>
        )}
      </div>
    );
  }

  return (
    <div className={sidebarOpen ? "app" : "app sidebar-collapsed"}>
      {/* たたんだ左の欄は消さずに隠す（書きかけの編集を残す） */}
      <aside className="sidebar" id="sidebar">
        <header className="brand">
          <h1>Loopsight ビューア</h1>
          <span className={`live ${connected ? "on" : ""}`} title={connected ? "ファイルの変更を見ています" : "サーバーにつながっていません"}>
            <span className="dot" />
            {connected ? "ライブ" : "未接続"}
          </span>
          <button
            className="sidebar-collapse"
            ref={collapseRef}
            onClick={() => toggleSidebar(false)}
            title="左の欄をたたんで、図とグラフを広く使います"
            aria-label="左の欄をたたむ"
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
          >
            ◀
          </button>
        </header>

        <section className="panel">
          <h2>{scenario ? "シナリオ" : selectedLink ? "選んだ線" : selectedNote !== undefined ? "選んだ注釈" : "選んだ要素"}</h2>
          {scenario && data ? (
            <ScenarioEditor
              key={scenario.id}
              model={data.model}
              name={scenario.name}
              onSave={saveScenarioDescription}
              onClose={() => setScenario(undefined)}
            />
          ) : selectedEl ? (
            <Details el={selectedEl} value={finalValues[selectedEl.name!]} onSave={(patch) => edit([patch])} />
          ) : selectedLinkEl ? (
            // リンクは、何から何への線かと、遅れの印（‖）の付け外しを出す
            <p className="link-details">
              <span>
                <strong>{selectedLinkEl.from}</strong> → <strong>{selectedLinkEl.to}</strong> のリンク
              </span>
              <DelayToggle
                key={`${selectedLinkEl.from}→${selectedLinkEl.to}`}
                on={hasDelayMark(selectedLinkEl)}
                onChange={(on) => edit([{ type: "LINK", from: selectedLinkEl.from!, to: selectedLinkEl.to!, display: { delay: on } }])}
              />
              <span className="muted">{linkLocked ?? (editMode ? "「削除」か Delete キーで消せます。" : "消すときは、図の左上の「図を編集」をオンにします。")}</span>
            </p>
          ) : selectedLink && data ? (
            <p className="muted">選んでいたリンクが見つかりません。消された可能性があります。</p>
          ) : selectedNoteEl ? (
            <NoteDetails note={selectedNoteEl} editMode={editMode} onSave={(patch) => edit([], [patch])} />
          ) : selectedNote !== undefined && data ? (
            <p className="muted">選んでいた注釈「{selectedNote}」が見つかりません。消された可能性があります。</p>
          ) : selected && data ? (
            <p className="muted">選んでいた「{selected}」が見つかりません。名前が変わったか、消された可能性があります。図で選び直してください。</p>
          ) : (
            <p className="muted">図の要素を押すと、式などをここに出します。「編集」で直せます。</p>
          )}
        </section>

        {data && <GroupPanel model={data.model} selected={selectedEl?.name} onSave={editGroups} />}

        {data && <Problems data={data} onSelect={selectElement} />}

        <section className="panel models-panel">
          <h2>
            <button className="panel-toggle" onClick={toggleModels} aria-expanded={modelsOpen}>
              <span className="chevron">{modelsOpen ? "▾" : "▸"}</span>
              モデル
              {!modelsOpen && list && <span className="count">{list.models.length}</span>}
            </button>
          </h2>
          {modelsOpen && (
            <>
              {list && list.models.length === 0 && <p className="muted">作業フォルダ（{list.dir}）にモデルがありません。</p>}
              <ModelTree nodes={tree} current={current} open={openFolders} onToggle={toggleFolder} />
            </>
          )}
        </section>
      </aside>
      {/* たたんだときに左端に残す帯。押すと左の欄を開く */}
      <button
        className="sidebar-strip"
        ref={stripRef}
        onClick={() => toggleSidebar(true)}
        title={`左の欄（選んだ要素の詳細・問題・モデルの一覧）を開きます${problemText ? `（${problemText}）` : ""}`}
        aria-label={`左の欄を開く${problemText ? `（${problemText}）` : ""}`}
        aria-expanded={sidebarOpen}
        aria-controls="sidebar"
      >
        <span aria-hidden="true">▶</span>
        <span className="sidebar-strip-label">左の欄</span>
        {problemText && (
          <span className={problemCount.errors ? "sidebar-strip-problems error" : "sidebar-strip-problems warning"} aria-hidden="true">
            ⚠<br />
            {stripCount(problemCount.errors || problemCount.warnings)}
          </span>
        )}
      </button>

      <main className="main" ref={mainRef}>
        <div className="toolbar">
          <div className="title">
            <h2 title={title}>{title || "モデルを選んでください"}</h2>
            {data?.model.description && (
              <p className="muted" title={data.model.description}>
                {data.model.description}
              </p>
            )}
          </div>
          {graph && data && (
            <div className="toolbar-right">
              {graph.missingCoordinates && <InfoTip text="座標のない要素を仮に並べています。「図を編集」で動かすと、この配置を保存します" />}
              <button
                className="toolbar-button"
                onClick={() => void undo()}
                disabled={!data.undo_available}
                title={data.undo_available ? `画面で変えたことを元に戻します（あと ${data.undo_available} 回、Ctrl+Z）` : "元に戻せる変更はありません"}
              >
                ↶ 元に戻す
              </button>
              {updatedAt && <span className="muted small">{busy ? "保存しています…" : `更新 ${updatedAt.toLocaleTimeString("ja-JP")}`}</span>}
            </div>
          )}
        </div>
        {error && <div className="banner error">{error}</div>}
        {notice && (
          <div className="banner notice">
            <span>{notice}</span>
            <button className="link" onClick={() => setNotice(undefined)}>
              閉じる
            </button>
          </div>
        )}

        {/* グラフ・表を広げている間の、図の見出しだけの帯。押すと上下に分けた形に戻す */}
        {expanded === "results" && (
          <button className="pane-band" onClick={() => expandPane(undefined)} title="図とグラフ・表を上下に分けた形に戻します">
            図 ▼
          </button>
        )}

        {/* 編集モードの間は、図の窓の色と縁を変える（図の形を変えられると一目でわかるように）。
            帯にしている間も図は消さずに隠すだけにする（ズームや位置、ライブの更新をそのまま保つ） */}
        <div className={`diagram ${editMode && graph && data ? "is-editing" : ""} ${expanded === "results" ? "is-collapsed" : ""}`} ref={diagramRef}>
          {graph && data ? (
            diagramShown && (
              <ReactFlowProvider>
                <Diagram
                  graph={graph}
                  modelName={data.name}
                  selected={selected}
                  changed={changed}
                  values={finalValues}
                  onSelect={selectElement}
                  onMove={move}
                  scenario={scenarioMarks}
                  editable={editMode}
                  onEditableChange={changeEditMode}
                  keepView={data.version === keepView}
                  holdView={resizing || switchingPane}
                  onAdd={addElement}
                  onAddNote={addNote}
                  selectedNote={selectedNote}
                  onSelectNote={selectNote}
                  selectedLink={selectedLink}
                  onSelectLink={selectLink}
                  onLink={addLink}
                  onReconnect={reconnectFlow}
                  removable={removable}
                  onRemove={removeSelected}
                  liveValues={liveValues}
                  valueTools={valueTools}
                  formula={selectedFormula}
                  onExport={exportDiagramFiles}
                  paneTools={<ExpandButton pane="diagram" expanded={expanded} onChange={expandPane} className="edit-toggle" />}
                />
              </ReactFlowProvider>
            )
          ) : (
            !error && <p className="muted pad">読み込んでいます…</p>
          )}
        </div>

        {/* 境界線。上下にドラッグして下の欄の高さを変える（狭い画面と、どちらかを広げている間は出さない） */}
        {!expanded && (
          <div
            className={`splitter ${resizing ? "dragging" : ""}`}
            role="separator"
            aria-orientation="horizontal"
            title="上下にドラッグして、図とグラフの高さを変えます"
            onPointerDown={(e) => {
              const main = mainRef.current?.getBoundingClientRect();
              const diagram = diagramRef.current?.getBoundingClientRect();
              const results = resultsRef.current?.getBoundingClientRect();
              if (e.button !== 0 || !main || !diagram || !results) return;
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              resizeStart.current = { y: e.clientY, results: results.height, diagram: diagram.height, main: main.height };
              setResizing(true);
            }}
            onPointerMove={(e) => {
              const start = resizeStart.current;
              if (!start) return;
              resultsRatioRef.current = draggedResultsRatio(start, e.clientY - start.y);
              setResultsRatio(resultsRatioRef.current);
            }}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            // ほかの理由でキャプチャが外れたとき（狭い画面になって境界線が消えたなど）も終える
            onLostPointerCapture={endResize}
          />
        )}

        {/* 図を広げている間の、グラフ・表の見出しだけの帯。押すと上下に分けた形に戻す */}
        {expanded === "diagram" && (
          <button className="pane-band" onClick={() => expandPane(undefined)} title="図とグラフ・表を上下に分けた形に戻します">
            グラフ・表 ▲
          </button>
        )}

        {/* 帯にしている間もグラフ・表は消さずに隠すだけにする（選んでいる要素や表の切り替えを保つ） */}
        <div
          className={`results ${expanded === "diagram" ? "is-collapsed" : expanded === "results" ? "is-expanded" : ""}`}
          ref={resultsRef}
          style={{ "--results-ratio": resultsRatio } as CSSProperties}
        >
          {data?.run ? (
            <Chart
              modelName={data.name}
              model={data.model}
              run={data.run}
              scenarios={data.scenarios}
              actual={data.actual}
              renamed={renamed}
              editingScenario={scenario?.name}
              onEditScenario={editScenarioDescription}
              onSaveScenario={saveScenarioValue}
              onRemoveScenario={removeScenario}
              onRemoveScenarioValue={removeScenarioValue}
              onFocusScenario={setHoveredScenario}
              onHoverTime={showValues ? setHoverTime : undefined}
              tools={<ExpandButton pane="results" expanded={expanded} onChange={expandPane} className="toolbar-button" />}
            />
          ) : data ? (
            <p className="muted pad">エラーがあるため実行できません。左の欄の「問題」を見てください。</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
