import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ElementPatch, ModelElement, ModelListResponse, ModelResponse } from "../../src/viewer/api.js";
import { fetchList, fetchModel, postEdit, postUndo, type WriteResult } from "./api.js";
import { Chart, formatValue } from "./Chart.js";
import { Details } from "./Details.js";
import { Diagram } from "./Diagram.js";
import { toGraph } from "./graph.js";
import { Problems } from "./Problems.js";

// 画面全体：左にモデル一覧と選んだ要素の詳しい情報、右に図とグラフ。
// サーバーからの変更の知らせ（Server-Sent Events）で、開いているモデルを取り直す。
// 画面からの編集（式などの変更、位置の変更、元に戻す）はサーバーに送り、同じファイルに書き戻す。

const nameFromHash = () => decodeURIComponent(location.hash.replace(/^#/, ""));

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

/** 入力欄で打っているときは、元に戻すのショートカットを横取りしない */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function App() {
  const [list, setList] = useState<ModelListResponse>();
  const [current, setCurrent] = useState(nameFromHash());
  const [data, setData] = useState<ModelResponse>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [autoLayout, setAutoLayout] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [busy, setBusy] = useState(false);
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

  const loadList = useCallback(async () => {
    try {
      setList(await fetchList());
    } catch (e) {
      setError(`モデルの一覧を読めません: ${(e as Error).message}`);
    }
  }, []);

  /** 新しい内容を表示する。highlight なら、変わった要素に枠を付ける（ほかで変わったとき） */
  const show = useCallback((next: ModelResponse, highlight: boolean) => {
    // これより前に始めた読み込みの結果は捨てる
    loadSeq.current++;
    const diff = highlight ? changedElements(dataRef.current, next) : new Set<string>();
    dataRef.current = next;
    setData(next);
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
        // 画面から書き込んだ結果の知らせなら、もう表示しているので何もしない
        if (dataRef.current?.name === next.name && dataRef.current.version === next.version) return;
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
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
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
    setNotice(undefined);
    setAutoLayout(false);
    void loadModel(current);
  }, [current, loadModel]);

  /** 書き込みの結果を画面に反映する。失敗したらその文を返す */
  const applyWrite = useCallback(
    (result: WriteResult): string | undefined => {
      if (result.ok) {
        show(result.data.model, false);
        setNotice(undefined);
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

  /** 書き込みを順番待ちに入れる。版は、順番が来たときに表示している最新のものを使う */
  const enqueueWrite = useCallback(
    <T,>(task: () => Promise<T>): Promise<T> => {
      pendingWrites.current++;
      setBusy(true);
      const run = writeQueue.current.then(task, task);
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
      enqueueWrite(async () => {
        const d = dataRef.current;
        if (!d) return "モデルを読み込んでいません。";
        return applyWrite(await postEdit(d.name, d.version, elements));
      }),
    [applyWrite, enqueueWrite],
  );

  const undo = useCallback(
    () =>
      enqueueWrite(async () => {
        const d = dataRef.current;
        if (!d || !d.undo_available) return;
        const err = applyWrite(await postUndo(d.name, d.version));
        if (err) setNotice(err);
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

  /** 図で動かした位置を保存する。自動配置で見ていたなら、保存後はモデルの座標で見る */
  const move = useCallback(
    async (patches: ElementPatch[]) => {
      const err = await edit(patches);
      if (err) setNotice(err);
      else setAutoLayout(false);
      return err;
    },
    [edit],
  );

  const graph = useMemo(() => (data ? toGraph(data.model, { forceAutoLayout: autoLayout }) : undefined), [data, autoLayout]);
  const finalValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data?.run?.series ?? {})) out[k] = formatValue(v.at(-1));
    return out;
  }, [data]);
  // 名前は大文字と小文字を区別しない（AI が表記だけ変えても選んだままにする）
  const selectedEl = selected ? data?.model.elements.find((e) => e.name && e.name.toLowerCase() === selected.toLowerCase()) : undefined;
  const title = data?.model.name || current;

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>Insight Maker ビューア</h1>
          <span className={`live ${connected ? "on" : ""}`} title={connected ? "ファイルの変更を見ています" : "サーバーにつながっていません"}>
            <span className="dot" />
            {connected ? "ライブ" : "未接続"}
          </span>
        </header>

        <section className="panel">
          <h2>モデル</h2>
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
        </section>

        {data && <Problems data={data} onSelect={setSelected} />}

        <section className="panel">
          <h2>選んだ要素</h2>
          {selectedEl ? (
            <Details el={selectedEl} value={finalValues[selectedEl.name!]} onSave={(patch) => edit([patch])} />
          ) : selected && data ? (
            <p className="muted">選んでいた「{selected}」が見つかりません。名前が変わったか、消された可能性があります。図で選び直してください。</p>
          ) : (
            <p className="muted">図の要素を押すと、式などをここに出します。「編集」で直せます。</p>
          )}
        </section>
      </aside>

      <main className="main">
        <div className="toolbar">
          <div className="title">
            <h2>{title || "モデルを選んでください"}</h2>
            {data?.model.description && <p className="muted">{data.model.description}</p>}
          </div>
          {graph && data && (
            <div className="toolbar-right">
              {graph.autoLayout && (
                <span className="note">
                  {graph.missingCoordinates ? "座標のない要素があるので自動配置にしています。" : "自動配置で表示しています。"}動かすと、この配置を保存します
                </span>
              )}
              <label className="toggle">
                <input type="checkbox" checked={graph.autoLayout} disabled={graph.missingCoordinates} onChange={(e) => setAutoLayout(e.target.checked)} />
                自動配置
              </label>
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

        <div className="diagram">
          {graph && data ? (
            <ReactFlowProvider>
              <Diagram
                graph={graph}
                modelName={data.name}
                selected={selected}
                changed={changed}
                values={finalValues}
                onSelect={setSelected}
                onMove={move}
              />
            </ReactFlowProvider>
          ) : (
            !error && <p className="muted pad">読み込んでいます…</p>
          )}
        </div>

        <div className="results">
          {data?.run ? (
            <Chart modelName={data.name} model={data.model} run={data.run} />
          ) : data ? (
            <p className="muted pad">エラーがあるため実行できません。左の「問題」を見てください。</p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
