import { useState } from "react";
import { LOOP_KIND_LABEL } from "../../src/core/loops.js";
import { countLoops, truncatedText, type LoopList } from "./loopList.js";

// フィードバックループの欄（左の欄）。AI の find_loops と同じループを並べ、押したループを図で目立たせる
// （view_diagram の loop と同じ描き方）。もう一度押すか、ほかのループを押すとやめる。

const OPEN_KEY = "viewer.loopsOpen";

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
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
}

export function LoopPanel({ list, shown, onShow }: LoopPanelProps) {
  const [open, setOpen] = useState(loadOpen);
  const toggle = () => {
    saveOpen(!open);
    setOpen(!open);
  };
  const { loops } = list;
  const count = countLoops(loops);
  const summary = [count.R ? `R ${count.R}` : "", count.B ? `B ${count.B}` : "", count.unknown ? `? ${count.unknown}` : ""].filter(Boolean).join("・");
  const truncated = truncatedText(list.truncated);

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
              <p className="muted small">押すと、図でそのループを目立たせます。もう一度押すとやめます。</p>
              <ul className="loop-list">
                {loops.map((l) => {
                  const on = l.key === shown;
                  return (
                    <li key={l.key}>
                      <button
                        className={`loop-row loop-${l.kind.toLowerCase()} ${on ? "on" : ""}`}
                        aria-pressed={on}
                        onClick={() => onShow(on ? undefined : l.key)}
                        title={on ? "目立たせるのをやめます" : "図でこのループを目立たせます"}
                      >
                        <span className="loop-row-kind" aria-hidden>
                          {l.kind === "unknown" ? "?" : l.kind}
                        </span>
                        <span className="loop-row-text">
                          <span className="loop-row-head">
                            <span className="loop-row-name">{l.name}</span>
                            <span className="muted small">{l.kind === "unknown" ? "R か B か決まっていない" : LOOP_KIND_LABEL[l.kind]}</span>
                            {l.delay && (
                              <span className="loop-row-delay small" title="遅れの印（‖）のあるつながりを通ります。遅れのある釣り合わせるループ（B）は、行き過ぎて振れやすくなります">
                                ‖ 遅れあり
                              </span>
                            )}
                          </span>
                          <span className="loop-row-elements small">{[...l.elements, l.elements[0]].join(" → ")}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {count.unknown > 0 && <p className="muted small">極性（+ / −）が決まっていないつながりがあります。リンクの線を押して極性を付けると、R か B かが決まります（フローの式がリンクなしで自分のストックを使っているところは、そのストックからフローへリンクを引いて極性を付けます）。</p>}
              {truncated && <p className="muted small">{truncated}</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
