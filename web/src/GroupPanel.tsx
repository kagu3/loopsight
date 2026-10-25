import { useEffect, useRef, useState } from "react";
import { GROUP_COLOR_LABEL, GROUP_COLORS, groupOf, isGroupColor, nextGroupName, wellFormedGroups } from "../../src/core/groups.js";
import type { GroupPatch, ModelJSON } from "../../src/viewer/api.js";

// 図のグループの欄（左の欄）。グループの名前と色を直し、足し、消す。図で要素を選んでいるときは、その要素のグループも選べる。
// 変更は MCP の set_groups と同じ形でサーバーに送る（AI も同じことができる）。消しても ↶ 元に戻す（Ctrl+Z）で戻せる。

const OPEN_KEY = "viewer.groupsOpen";

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

export interface GroupPanelProps {
  model: ModelJSON;
  /** 図で選んでいる要素（リンクでないもの）の名前 */
  selected?: string;
  /** 保存する（set_groups と同じ形）。失敗したらエラーの文を返す */
  onSave(patches: GroupPatch[], remove?: string[]): Promise<string | undefined>;
}

export function GroupPanel({ model, selected, onSave }: GroupPanelProps) {
  const groups = wellFormedGroups(model);
  const [open, setOpen] = useState(loadOpen);
  const [error, setError] = useState<string>();
  const toggle = () => {
    saveOpen(!open);
    setOpen(!open);
  };
  const save = async (patches: GroupPatch[], remove?: string[]) => setError(await onSave(patches, remove));
  const current = selected ? groupOf(model, selected) : undefined;

  return (
    <section className="panel groups-panel">
      <h2>
        <button className="panel-toggle" onClick={toggle} aria-expanded={open}>
          <span className="chevron">{open ? "▾" : "▸"}</span>
          グループ
          {!open && groups.length > 0 && <span className="count">{groups.length}</span>}
        </button>
      </h2>
      {open && (
        <div className="groups-body">
          {groups.length === 0 && <p className="muted small">意味のまとまり（「お店側」「お客側」など）をグループにすると、図で背景の色で囲み、凡例を出します。</p>}
          <ul className="group-list">
            {groups.map((g) => (
              <li key={g.name} className="group-row">
                <select
                  className={`group-color group-${isGroupColor(g.color) ? g.color : "gray"}`}
                  value={isGroupColor(g.color) ? g.color : "gray"}
                  onChange={(e) => void save([{ name: g.name, color: e.target.value }])}
                  aria-label={`グループ「${g.name}」の色`}
                  title="背景の色を選びます"
                >
                  {GROUP_COLORS.map((c) => (
                    <option key={c} value={c}>
                      {GROUP_COLOR_LABEL[c]}
                    </option>
                  ))}
                </select>
                <GroupName name={g.name} onRename={(to) => void save([{ name: g.name, rename_to: to }])} />
                <span className="muted small group-count" title={g.elements.length ? g.elements.join("、") : "要素がありません（図には出ません）"}>
                  {g.elements.length}
                </span>
                <button className="link group-remove" onClick={() => void save([], [g.name])} title={`グループ「${g.name}」を消します（要素は消えません。↶ 元に戻すで戻せます）`} aria-label={`グループ「${g.name}」を消す`}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {selected && groups.length > 0 && (
            <label className="group-of">
              <span>「{selected}」のグループ</span>
              <select
                value={current?.name ?? ""}
                onChange={(e) => {
                  const to = e.target.value;
                  if (to === "") void save([{ name: current!.name, remove_elements: [selected] }]);
                  else void save([{ name: to, add_elements: [selected] }]);
                }}
              >
                <option value="">なし</option>
                {groups.map((g) => (
                  <option key={g.name} value={g.name}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="link group-add"
            onClick={() => void save([{ name: nextGroupName(groups), ...(selected ? { elements: [selected] } : {}) }])}
            title={selected ? `新しいグループを足し、「${selected}」を入れます` : "新しいグループを足します。図で要素を選んでから押すと、その要素を入れます"}
          >
            ＋ グループを足す
          </button>
          {error && <p className="form-error">{error}</p>}
        </div>
      )}
    </section>
  );
}

/** グループの名前の欄。Enter か欄から離れると保存し、Esc で元に戻す */
function GroupName({ name, onRename }: { name: string; onRename(to: string): void }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  // Esc で離れたときは保存しない
  const cancelled = useRef(false);
  const commit = () => {
    const to = value.trim();
    if (cancelled.current) {
      cancelled.current = false;
      setValue(name);
      return;
    }
    if (to && to !== name) onRename(to);
    else setValue(name);
  };
  return (
    <input
      className="group-name"
      value={value}
      aria-label="グループの名前"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
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
