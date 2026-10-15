import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, Issue, ModelElement, ModelListResponse, ModelResponse } from "../../src/viewer/api.js";
import { Chart, formatValue } from "./Chart.js";
import { Diagram } from "./Diagram.js";
import { toGraph } from "./graph.js";

// 画面全体：左にモデル一覧と選んだ要素の詳しい情報、右に図とグラフ。
// サーバーからの変更の知らせ（Server-Sent Events）で、開いているモデルを取り直す。

const nameFromHash = () => decodeURIComponent(location.hash.replace(/^#/, ""));

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
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

export function App() {
  const [list, setList] = useState<ModelListResponse>();
  const [current, setCurrent] = useState(nameFromHash());
  const [data, setData] = useState<ModelResponse>();
  const [error, setError] = useState<string>();
  const [connected, setConnected] = useState(false);
  const [autoLayout, setAutoLayout] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const dataRef = useRef<ModelResponse>(undefined);
  const currentRef = useRef(current);
  currentRef.current = current;

  const loadList = useCallback(async () => {
    try {
      setList(await getJSON<ModelListResponse>("/api/models"));
    } catch (e) {
      setError(`モデルの一覧を読めません: ${(e as Error).message}`);
    }
  }, []);

  const loadModel = useCallback(async (name: string) => {
    if (!name) return;
    try {
      const next = await getJSON<ModelResponse>(`/api/models/${encodeURIComponent(name)}`);
      if (currentRef.current !== name) return;
      const diff = changedElements(dataRef.current, next);
      dataRef.current = next;
      setData(next);
      setError(undefined);
      setUpdatedAt(new Date());
      if (diff.size) {
        setChanged(diff);
        setTimeout(() => setChanged(new Set()), 2500);
      }
    } catch (e) {
      setError(`モデル "${name}" を読めません: ${(e as Error).message}`);
    }
  }, []);

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
    void loadModel(current);
  }, [current, loadModel]);

  const graph = useMemo(() => (data ? toGraph(data.model, { forceAutoLayout: autoLayout }) : undefined), [data, autoLayout]);
  const finalValues = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data?.run?.series ?? {})) out[k] = formatValue(v.at(-1));
    return out;
  }, [data]);
  const selectedEl = data?.model.elements.find((e) => e.name && e.name === selected);
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
          {selectedEl ? <Details el={selectedEl} value={finalValues[selectedEl.name!]} /> : <p className="muted">図の要素を押すと、式などをここに出します。</p>}
        </section>
      </aside>

      <main className="main">
        <div className="toolbar">
          <div className="title">
            <h2>{title || "モデルを選んでください"}</h2>
            {data?.model.description && <p className="muted">{data.model.description}</p>}
          </div>
          {graph && (
            <div className="toolbar-right">
              {graph.missingCoordinates && <span className="note">座標のない要素があるので自動配置にしています</span>}
              <label className="toggle">
                <input type="checkbox" checked={graph.autoLayout} disabled={graph.missingCoordinates} onChange={(e) => setAutoLayout(e.target.checked)} />
                自動配置
              </label>
              {updatedAt && <span className="muted small">更新 {updatedAt.toLocaleTimeString("ja-JP")}</span>}
            </div>
          )}
        </div>
        {error && <div className="banner error">{error}</div>}

        <div className="diagram">
          {graph && data ? (
            <ReactFlowProvider>
              <Diagram graph={graph} modelName={data.name} selected={selected} changed={changed} values={finalValues} onSelect={setSelected} />
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

function Problems({ data, onSelect }: { data: ModelResponse; onSelect(name: string): void }) {
  const issues: { level: "error" | "warning"; issue: Issue }[] = [
    ...data.validation.errors.map((issue) => ({ level: "error" as const, issue })),
    ...(data.run_error ? (data.run_error.issues.length ? data.run_error.issues : [{ message: data.run_error.message }]) : []).map((issue) => ({
      level: "error" as const,
      issue,
    })),
    ...data.validation.warnings.map((issue) => ({ level: "warning" as const, issue })),
  ];
  if (!issues.length) return null;
  return (
    <section className="panel">
      <h2>問題</h2>
      <ul className="issues">
        {issues.map(({ level, issue }, i) => (
          <li key={i} className={level}>
            <span className="issue-level">{level === "error" ? "エラー" : "警告"}</span>
            {issue.element ? (
              <button className="link" onClick={() => onSelect(issue.element!)}>
                {issue.element}
              </button>
            ) : null}
            <span>{issue.message}</span>
            {issue.hint && <span className="muted"> {issue.hint}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TYPE_LABEL: Record<string, string> = {
  STOCK: "ストック",
  FLOW: "フロー",
  VARIABLE: "変数",
  CONVERTER: "コンバーター",
  STATE: "状態",
  TRANSITION: "遷移",
};

function Details({ el, value }: { el: ModelElement; value?: string }) {
  const b = el.behavior ?? {};
  const rows: [string, string][] = [];
  if (el.type === "FLOW" || el.type === "TRANSITION") rows.push(["流れ", `${el.from ?? "（外）"} → ${el.to ?? "（外）"}`]);
  if (b.initial_value !== undefined) rows.push(["初期値", String(b.initial_value)]);
  if (b.value !== undefined) rows.push([el.type === "FLOW" ? "流量" : "式", String(b.value)]);
  if (el.type === "CONVERTER") {
    rows.push(["入力", b.input === "ELEMENT" ? String(b.input_element ?? "") : "時間"]);
    if (Array.isArray(b.data)) rows.push(["表", (b.data as [number, number][]).map(([x, y]) => `${x}→${y}`).join(", ")]);
  }
  if (b.units) rows.push(["単位", String(b.units)]);
  if (b.non_negative) rows.push(["負にしない", "はい"]);
  if (value !== undefined) rows.push(["最終値", value]);
  return (
    <div className="details">
      <div className="details-head">
        <span className={`type-badge type-${el.type.toLowerCase()}`}>{TYPE_LABEL[el.type] ?? el.type}</span>
        <strong>{el.name}</strong>
      </div>
      {el.description && <p className="muted">{el.description}</p>}
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={k === "式" || k === "流量" || k === "初期値" ? "code" : ""}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
