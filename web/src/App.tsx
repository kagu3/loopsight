import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChangeEvent, ElementPatch, ModelElement, ModelListResponse, ModelResponse, ScenarioPatch } from "../../src/viewer/api.js";
import { fetchList, fetchModel, postEdit, postRemove, postScenarios, postUndo, type WriteResult } from "./api.js";
import { Chart, formatValue, scenarioColor } from "./Chart.js";
import { Details } from "./Details.js";
import { Diagram, type LinkEnds, type ScenarioMarks } from "./Diagram.js";
import { addElementPatches, linkProblem, linkRemoveProblem, renamedName, type NewElementType } from "./editing.js";
import { toGraph } from "../../src/core/diagram.js";
import { LOOP_KIND_LABEL, type LoopView } from "../../src/core/loops.js";
import { findLink, sameName } from "../../src/core/modeljson.js";
import { Problems } from "./Problems.js";
import { ScenarioEditor } from "./ScenarioEditor.js";
import { findScenario, scenarioBadges } from "./scenarios.js";
import { draggedResultsRatio, parseResultsRatio, RESULTS_RATIO } from "./split.js";

// 画面全体：左にモデル一覧と選んだ要素の詳しい情報、右に図とグラフ。
// サーバーからの変更の知らせ（Server-Sent Events）で、開いているモデルを取り直す。
// 画面からの編集（式などの変更、位置の変更、施策の変更、元に戻す）はサーバーに送り、同じファイルに書き戻す。
// 図の形を変える操作（配置のドラッグ、要素を足す・消す、線を引く・消す）は、図の左上の「図を編集」をオンにしたときだけできる。
// 値（詳細欄の「編集」）や施策は、「図を編集」に関係なく、いつでも直せる（入力欄に打ち込む操作で、元に戻すでも戻せるため）。

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
  // 左の欄で直している施策。name がなければ、施策を足している
  const [scenario, setScenario] = useState<{ name?: string }>();
  // 保存を待つあいだに、ほかのモデルや要素、施策を開いたかを確かめるため
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  // グラフの上の施策の凡例にカーソルを乗せている施策
  const [hoveredScenario, setHoveredScenario] = useState<string>();
  const [changed, setChanged] = useState<Set<string>>(new Set());
  // いま出している版で名前の変わった要素（画面で名前を変えた・元に戻したとき）。グラフに出す要素を新しい名前に合わせる
  const [renamed, setRenamed] = useState<[string, string][]>(NO_RENAMES);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [busy, setBusy] = useState(false);
  // 編集モード（図の左上の「図を編集」。図の形を変える操作をできるようにする）。うっかり動かさないよう、開くたびにオフから始める（ブラウザに覚えさせない）
  const [editMode, setEditMode] = useState(false);
  // 画面で要素を足した・消した・名前を変えた（元に戻した）あとの版。この版を出している間は、要素が増減しても図の見る場所を合わせ直さない
  const [keepView, setKeepView] = useState<string>();
  // 要素を消したときの知らせ。元に戻したら閉じる
  const removedNotice = useRef<string>(undefined);
  const [modelsOpen, setModelsOpen] = useState(loadModelsOpen);
  const toggleModels = () =>
    setModelsOpen((open) => {
      saveModelsOpen(!open);
      return !open;
    });
  const [resultsRatio, setResultsRatio] = useState(loadResultsRatio);
  // 境界線をドラッグしている間（図の欄の大きさが変わっても、図の見る場所を合わせ直さない）
  const [resizing, setResizing] = useState(false);
  const resultsRatioRef = useRef(resultsRatio);
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
          prev.actual?.version === next.actual?.version &&
          prev.slides?.version === next.slides?.version
        ) {
          // 中身は同じ（画面から書き込んだ結果の知らせなど）。元に戻せる回数だけ変わることがある（サーバーを起動し直したときなど）
          if (prev.undo_available !== next.undo_available) show(next, false);
          return;
        }
        show(next, true);
      } catch (e) {
        setError(`モデル "${name}" を読めません: ${(e as Error).message}`);
      }
    },
    [show],
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
      if (ev.name.toLowerCase() === currentRef.current.toLowerCase()) {
        if (ev.type === "changed") void loadModel(currentRef.current);
        else setError(`モデル "${ev.name}" のファイルが消えました。`);
      }
    };
    const onHash = () => setCurrent(nameFromHash());
    window.addEventListener("hashchange", onHash);
    return () => {
      es.close();
      window.removeEventListener("hashchange", onHash);
    };
  }, [loadList, loadModel]);

  // 何も開いていなければ、いちばん最近変わったモデルを開く
  useEffect(() => {
    if (current || !list?.models.length) return;
    const latest = [...list.models].sort((a, b) => b.modified.localeCompare(a.modified))[0]!;
    location.hash = encodeURIComponent(latest.name);
  }, [list, current]);

  useEffect(() => {
    dataRef.current = undefined;
    setData(undefined);
    setSelected(undefined);
    setSelectedLink(undefined);
    setScenario(undefined);
    setHoveredScenario(undefined);
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

  const edit = useCallback(
    (elements: ElementPatch[]): Promise<string | undefined> =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        return applyWrite(await postEdit(d.name, d.version, elements));
      }, SKIPPED_MESSAGE),
    [applyWrite, enqueueWrite],
  );

  /** 施策を足す・直す・消す（MCP の set_scenarios と同じ形） */
  const editScenarios = useCallback(
    (patches: ScenarioPatch[], remove?: string[]): Promise<string | undefined> =>
      enqueueWrite<string | undefined>(async () => {
        const d = dataRef.current;
        if (!d || !sameModel(d.name, currentRef.current)) return "モデルを読み込んでいません。";
        return applyWrite(await postScenarios(d.name, d.version, patches, remove));
      }, SKIPPED_MESSAGE),
    [applyWrite, enqueueWrite],
  );
  const saveScenario = useCallback(
    async (patch: ScenarioPatch) => {
      const [model, target] = [currentRef.current, scenarioRef.current];
      const err = await editScenarios([patch]);
      // 足したり名前を変えたりしたら、その名前で編集欄を開いたままにする。待つあいだにほかを開いていたら、そのままにする
      if (!err && currentRef.current === model && scenarioRef.current === target) setScenario({ name: patch.rename_to ?? patch.name });
      return err;
    },
    [editScenarios],
  );
  /** 施策の中身の表で、施策の値をその場で直す。編集欄は開かない */
  const saveScenarioValue = useCallback((patch: ScenarioPatch) => editScenarios([patch]), [editScenarios]);
  const removeScenario = useCallback(
    async (name: string) => {
      const [model, target] = [currentRef.current, scenarioRef.current];
      const err = await editScenarios([], [name]);
      if (!err && currentRef.current === model && scenarioRef.current === target) setScenario(undefined);
      return err;
    },
    [editScenarios],
  );
  /** 図で要素を選ぶと、施策の編集欄を閉じて、その要素を出す */
  const selectElement = useCallback((name: string | undefined) => {
    setScenario(undefined);
    setSelected(name);
    setSelectedLink(undefined);
  }, []);
  /** 図で線を押してリンクを選ぶ。要素を選んだときと同じく、施策の編集欄を閉じる */
  const selectLink = useCallback((link: LinkEnds) => {
    setScenario(undefined);
    setSelected(undefined);
    setSelectedLink(link);
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
        const { name, patches } = addElementPatches(d.model, toGraph(d.model), type, at);
        const result = await postEdit(d.name, d.version, patches);
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
   * 消したことでほかに変わったこと（フローの端、式に残った参照、施策の値）は、知らせの帯に出す
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

  /** 図で動かした位置を保存する */
  const move = useCallback(
    async (patches: ElementPatch[]) => {
      const err = await edit(patches);
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
  // 図の札：注目している施策（凡例にカーソルを乗せている施策、なければ左の欄で直している施策）で変えた要素に、保存してある値を出す
  // 乗せたまま AI などが施策を消したり名前を変えたりして見つからなければ、直している施策に戻す
  const scenarioMarks = useMemo<ScenarioMarks | undefined>(() => {
    if (!data) return undefined;
    const name = [hoveredScenario, scenario?.name].find((n) => n !== undefined && findScenario(data.model, n));
    const s = name !== undefined ? findScenario(data.model, name) : undefined;
    if (name === undefined || !s) return undefined;
    // 色は施策の線の色。直している施策が実行できなかった・色が足りずに出していないときは、線がないので灰色にする
    const color = (data.run && scenarioColor(data.run, data.scenarios ?? [], name)) ?? "var(--text-secondary)";
    return { badges: scenarioBadges(data.model, s.values), color };
  }, [data, hoveredScenario, scenario?.name]);
  // 名前は大文字と小文字を区別しない（AI が表記だけ変えても選んだままにする）
  const selectedEl = selected ? data?.model.elements.find((e) => e.name && e.name.toLowerCase() === selected.toLowerCase()) : undefined;
  // 選んでいるリンク（AI などが消していれば、ない）
  const selectedLinkEl = selectedLink && data ? findLink(data.model, selectedLink.from, selectedLink.to) : undefined;
  // 編集モードで消せる要素（足せる種類と同じく、状態と遷移は消さない）か、リンク。
  // 施策の編集欄を開いている間は、左に出ていない要素を消さないよう、消せないことにする
  const removableName =
    editMode && !scenario && selectedEl && selectedEl.type !== "STATE" && selectedEl.type !== "TRANSITION" ? selectedEl.name : undefined;
  // 先の要素の式が使っているなど、消せないリンクの理由（左の欄に出し、「削除」は押せなくする）
  const linkLocked = selectedLinkEl && data ? linkRemoveProblem(data.model, selectedLinkEl.from!, selectedLinkEl.to!) : undefined;
  const [linkFrom, linkTo] = editMode && !scenario && selectedLinkEl && !linkLocked ? [selectedLinkEl.from!, selectedLinkEl.to!] : [];
  const removable = useMemo(
    () => (removableName ? { label: removableName, link: false } : linkFrom && linkTo ? { label: `${linkFrom} → ${linkTo}`, link: true } : undefined),
    [removableName, linkFrom, linkTo],
  );
  const removeSelected = useCallback(() => {
    if (removableName) void removeElement(removableName);
    else if (linkFrom && linkTo) void removeLink({ from: linkFrom, to: linkTo });
  }, [removableName, linkFrom, linkTo, removeElement, removeLink]);

  // 編集モードで要素かリンクを選んでいるときは、Delete キーで消す。
  // 文字を消すつもりで押されやすい Backspace は使わない。押しっぱなしの繰り返しは無視する。
  // 入力欄で打っているときと、左の欄（詳細欄の編集のボタンなど）にいるときは消さない（打ちかけの内容を失わないように）
  const canRemove = !!removable;
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
  const title = data?.model.name || current;

  if (EMBED) {
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
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>SD Modeler ビューア</h1>
          <span className={`live ${connected ? "on" : ""}`} title={connected ? "ファイルの変更を見ています" : "サーバーにつながっていません"}>
            <span className="dot" />
            {connected ? "ライブ" : "未接続"}
          </span>
        </header>

        <section className="panel">
          <h2>{scenario ? "施策" : selectedLink ? "選んだ線" : "選んだ要素"}</h2>
          {scenario && data ? (
            <ScenarioEditor
              key={scenario.name?.toLowerCase() ?? "（新しい施策）"}
              model={data.model}
              name={scenario.name}
              onSave={saveScenario}
              onRemove={removeScenario}
              onClose={() => setScenario(undefined)}
            />
          ) : selectedEl ? (
            <Details el={selectedEl} value={finalValues[selectedEl.name!]} onSave={(patch) => edit([patch])} />
          ) : selectedLinkEl ? (
            // リンクは直せる項目がないので、何から何への線かだけを出す
            <p className="link-details">
              <span>
                <strong>{selectedLinkEl.from}</strong> → <strong>{selectedLinkEl.to}</strong> のリンク
              </span>
              <span className="muted">{linkLocked ?? (editMode ? "「削除」か Delete キーで消せます。" : "消すときは、図の左上の「図を編集」をオンにします。")}</span>
            </p>
          ) : selectedLink && data ? (
            <p className="muted">選んでいたリンクが見つかりません。消された可能性があります。</p>
          ) : selected && data ? (
            <p className="muted">選んでいた「{selected}」が見つかりません。名前が変わったか、消された可能性があります。図で選び直してください。</p>
          ) : (
            <p className="muted">図の要素を押すと、式などをここに出します。「編集」で直せます。</p>
          )}
        </section>

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
              <ul className="model-list">
                {list?.models.map((m) => (
                  <li key={m.name}>
                    <a href={`#${encodeURIComponent(m.name)}`} className={m.name === current ? "on" : ""}>
                      <span className="model-name">{m.name}</span>
                      {m.title && m.title !== m.name && <span className="model-title">{m.title}</span>}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </aside>

      <main className="main" ref={mainRef}>
        <div className="toolbar">
          <div className="title">
            <h2>{title || "モデルを選んでください"}</h2>
            {data?.model.description && (
              <p className="muted" title={data.model.description}>
                {data.model.description}
              </p>
            )}
          </div>
          {graph && data && (
            <div className="toolbar-right">
              {graph.missingCoordinates && <span className="note">座標のない要素を仮に並べています。「図を編集」で動かすと、この配置を保存します</span>}
              <a
                className="toolbar-button"
                href={`?view=present#${encodeURIComponent(data.name)}`}
                target="_blank"
                rel="noopener"
                title={
                  data.slides
                    ? "会議資料の筋書きを、発表モードで別のタブに開きます（← → で進む）"
                    : "会議資料の筋書きはまだありません。AI に「会議資料を作って」と頼むと、発表モードで見られます"
                }
              >
                ▶ 発表
              </a>
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

        {/* 編集モードの間は、図の窓の色と縁を変える（図の形を変えられると一目でわかるように） */}
        <div className={`diagram ${editMode && graph && data ? "is-editing" : ""}`} ref={diagramRef}>
          {graph && data ? (
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
                onEditableChange={setEditMode}
                keepView={data.version === keepView}
                holdView={resizing}
                onAdd={addElement}
                selectedLink={selectedLink}
                onSelectLink={selectLink}
                onLink={addLink}
                removable={removable}
                onRemove={removeSelected}
              />
            </ReactFlowProvider>
          ) : (
            !error && <p className="muted pad">読み込んでいます…</p>
          )}
        </div>

        {/* 境界線。上下にドラッグして下の欄の高さを変える（狭い画面では出さない） */}
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

        <div className="results" ref={resultsRef} style={{ "--results-ratio": resultsRatio } as CSSProperties}>
          {data?.run ? (
            <Chart
              modelName={data.name}
              model={data.model}
              run={data.run}
              scenarios={data.scenarios}
              actual={data.actual}
              renamed={renamed}
              editingScenario={scenario?.name}
              onEditScenario={(name) => setScenario({ name })}
              onSaveScenario={saveScenarioValue}
              onFocusScenario={setHoveredScenario}
            />
          ) : data ? (
            <p className="muted pad">エラーがあるため実行できません。左の「問題」を見てください。</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
