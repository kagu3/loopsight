import { useEffect, useRef, useState } from "react";
import type { LoopPatch } from "../../src/viewer/api.js";
import { countLoops, loopPath, splitLoops, truncatedText, type LoopItem, type LoopList } from "./loopList.js";

// フィードバックループの欄（左の欄）。AI の find_loops と同じループを同じ順に並べ、押したループを図で目立たせる
// （view_diagram の loop と同じ描き方）。もう一度押すか、ほかのループを押すとやめる。
// 名前の付いたループ（モデルの loops）を上に、名前を大きく出す。名前のないループは「ほかの n 個」の下にたたむ
// （名前の付いたループが 1 つもなければ、全部を出す）。
// ✎ で名前を付け・直し・外す。変更は MCP の set_loops と同じ形でサーバーに送る（AI も同じことができる）。↶ 元に戻す（Ctrl+Z）で戻せる。

const OPEN_KEY = "viewer.loopsOpen";
const OTHERS_OPEN_KEY = "viewer.otherLoopsOpen";

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== "0";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // 覚えられなくても困らない
  }
}

export interface LoopPanelProps {
  list: LoopList;
  /** 図で目立たせているループの鍵（LoopItem の key） */
  shown?: string;
  /** ループを押した。目立たせているループなら undefined（やめる） */
  onShow(key: string | undefined): void;
  /** 名前を保存する（set_loops と同じ形）。失敗したらエラーの文を返す */
  onSave(patches: LoopPatch[], remove?: string[]): Promise<string | undefined>;
}

export function LoopPanel({ list, shown, onShow, onSave }: LoopPanelProps) {
  const [open, setOpen] = useState(() => loadFlag(OPEN_KEY, true));
  // 「ほかの n 個」は、たたんで始める。開け閉めはブラウザが覚える
  const [othersOpen, setOthersOpen] = useState(() => loadFlag(OTHERS_OPEN_KEY, false));
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState<string>();
  const toggle = () => {
    saveFlag(OPEN_KEY, !open);
    setOpen(!open);
  };
  const toggleOthers = () => {
    saveFlag(OTHERS_OPEN_KEY, !othersOpen);
    setOthersOpen(!othersOpen);
  };
  const { loops } = list;
  const { shown: named, others } = splitLoops(loops);
  // 目立たせているループがたたんだ中にあれば（AI が名前のないループを指したときなど）、見えるように開く
  const shownInOthers = shown !== undefined && others.some((l) => l.key === shown);
  useEffect(() => {
    if (shownInOthers) setOthersOpen(true);
  }, [shownInOthers]);
  const count = countLoops(loops);
  const summary = [count.R ? `R ${count.R}` : "", count.B ? `B ${count.B}` : "", count.unknown ? `? ${count.unknown}` : ""].filter(Boolean).join("・");
  const truncated = truncatedText(list.truncated);

  /** 名前を保存する。空にすると名前を外す */
  const rename = async (l: LoopItem, to: string) => {
    setEditing(undefined);
    const name = to.trim();
    if (name === (l.name ?? "")) return;
    if (!name) setError(await onSave([], [l.name!]));
    else if (l.name !== undefined) setError(await onSave([{ name: l.name, rename_to: name }]));
    else setError(await onSave([{ name, elements: l.elements }]));
  };

  const row = (l: LoopItem) => {
    const on = l.key === shown;
    const symbol = l.kind === "unknown" ? "?" : l.kind;
    const path = loopPath(l.elements);
    return (
      <li key={l.key} className="loop-item">
        {editing === l.key ? (
          <div className={`loop-row loop-${l.kind.toLowerCase()} editing`}>
            <span className="loop-row-kind" aria-hidden>
              {symbol}
            </span>
            <span className="loop-row-text">
              <LoopNameInput name={l.name ?? ""} onCommit={(to) => void rename(l, to)} onCancel={() => setEditing(undefined)} />
              <span className="loop-row-elements small" title={path}>
                {l.symbol}・{path}
              </span>
            </span>
          </div>
        ) : (
          <button
            className={`loop-row loop-${l.kind.toLowerCase()} ${on ? "on" : ""}`}
            aria-pressed={on}
            onClick={() => onShow(on ? undefined : l.key)}
            title={on ? "目立たせるのをやめます" : "図でこのループを目立たせます"}
          >
            <span className="loop-row-kind" aria-hidden>
              {symbol}
            </span>
            <span className="loop-row-text">
              <span className="loop-row-head">
                <span className="loop-row-name">{l.name ?? l.symbol}</span>
                {l.delay && (
                  <span className="loop-row-delay small" title="遅れの印（‖）のあるつながりを通ります。遅れのある釣り合わせるループ（B）は、行き過ぎて振れやすくなります">
                    ‖ 遅れあり
                  </span>
                )}
              </span>
              <span className="loop-row-elements small" title={path}>
                {l.name !== undefined ? `${l.symbol}・${path}` : path}
              </span>
            </span>
          </button>
        )}
        {editing !== l.key && (
          <button
            className="link loop-rename"
            onClick={() => {
              setError(undefined);
              setEditing(l.key);
            }}
            title={l.name !== undefined ? `名前「${l.name}」を直します（空にすると名前を外します）` : "このループに名前を付けます。名前の付いたループは一覧の上に出ます"}
            aria-label={l.name !== undefined ? `ループ「${l.name}」の名前を直す` : `ループ ${l.symbol} に名前を付ける`}
          >
            ✎
          </button>
        )}
      </li>
    );
  };

  return (
    <section className="panel loops-panel">
      <h2>
        <button className="panel-toggle" onClick={toggle} aria-expanded={open}>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          ループ
          {loops.length > 0 && (
            <span className="count" title={`強めるループ ${count.R} 個、釣り合わせるループ ${count.B} 個、決まっていないループ ${count.unknown} 個`}>
              {summary}
            </span>
          )}
        </button>
      </h2>
      {open && (
        <div className="loops-body">
          {loops.length === 0 ? (
            <p className="muted small">フィードバックループ（つながりをたどって元の要素に戻る輪）はありません。</p>
          ) : (
            <>
              <p className="muted small">
                原因を説明するときに使います。押すと、そのループだけを図に残します。R は増え続ける（または減り続ける）輪、B は落ち着かせる輪です。✎ で名前を付けると、一覧の上に出ます。
              </p>
              <ul className="loop-list">
                {named.map(row)}
                {others.length > 0 && (
                  <li className="loop-others">
                    <button className="link loop-others-toggle" onClick={toggleOthers} aria-expanded={othersOpen}>
                      <span className="chevron">{othersOpen ? "▾" : "▸"}</span>
                      ほかの {others.length} 個
                    </button>
                  </li>
                )}
                {othersOpen && others.map(row)}
              </ul>
              {count.unknown > 0 && <p className="muted small">極性（+ / −）が決まっていないつながりがあります。リンクの線を押して極性を付けると、R か B かが決まります（フローの式がリンクなしで自分のストックを使っているところは、そのストックからフローへリンクを引いて極性を付けます）。</p>}
              {truncated && <p className="muted small">{truncated}</p>}
            </>
          )}
          {list.missing.length > 0 && (
            <div className="loop-missing small">
              <span className="muted">名前を付けたループのうち、モデルにないもの（つながりを戻すと、また出ます）：</span>
              {list.missing.map((name) => (
                <span key={name} className="loop-missing-name">
                  {name}
                  <button className="link loop-rename" onClick={() => void onSave([], [name]).then(setError)} title={`名前「${name}」を外します（↶ 元に戻すで戻せます）`} aria-label={`ループの名前「${name}」を外す`}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
      )}
    </section>
  );
}

/** ループの名前の欄。Enter か欄から離れると保存し、Esc でやめる */
function LoopNameInput({ name, onCommit, onCancel }: { name: string; onCommit(to: string): void; onCancel(): void }) {
  const [value, setValue] = useState(name);
  // Esc で離れたときは保存しない
  const cancelled = useRef(false);
  return (
    <input
      className="loop-name-input"
      value={value}
      autoFocus
      placeholder="ループの名前（空にすると外す）"
      aria-label="ループの名前"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (cancelled.current ? onCancel() : onCommit(value))}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
