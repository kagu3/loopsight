import { useEffect, useRef, useState } from "react";
import type { ModelJSON, ScenarioPatch } from "../../src/viewer/api.js";
import { MAX_SERIES } from "./Chart.js";
import { BASELINE_NAME, currentValueOf, findScenario, scenarioFormOf, scenarioName, scenarioPatchOf, valueTargets, type ScenarioForm, type ValueRow } from "./scenarios.js";

// シナリオの編集欄。グラフの上のシナリオの凡例を押すと、左の欄に出す（要素の「編集」と同じ場所）。
// 変更は MCP の set_scenarios と同じ形（変えた項目だけ）でサーバーに送る。

const TYPE_LABEL: Record<string, string> = { STOCK: "ストック", VARIABLE: "変数", FLOW: "フロー" };

export interface ScenarioEditorProps {
  model: ModelJSON;
  /** 直すシナリオの名前。足すときは undefined */
  name?: string;
  /** 保存する。失敗したらエラーの文を返す */
  onSave(patch: ScenarioPatch): Promise<string | undefined>;
  /** シナリオを消す。失敗したらエラーの文を返す */
  onRemove(name: string): Promise<string | undefined>;
  /** 編集欄を閉じる */
  onClose(): void;
}

export function ScenarioEditor({ model, name, onSave, onRemove, onClose }: ScenarioEditorProps) {
  const scenario = name === undefined ? undefined : findScenario(model, name);
  const [form, setForm] = useState<ScenarioForm>(() => scenarioFormOf(scenario, name, model));
  // 編集を始めたときの中身。保存するときに、そのあいだに AI などがこのシナリオを変えていないか比べる
  const [base, setBase] = useState<ScenarioForm>(() => scenarioFormOf(scenario, name, model));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 保存したら、保存した中身（サーバーが要素の表記にそろえたもの）で欄を作り直す
  const resync = useRef(false);
  useEffect(() => {
    if (!resync.current) return;
    resync.current = false;
    setForm(scenarioFormOf(scenario, name, model));
    setBase(scenarioFormOf(scenario, name, model));
  }, [scenario, name, model]);

  // 保存しているあいだ（名前を変えたときや消したとき）は、見つからなくても欄を残す
  if (name !== undefined && !scenario && !saving) {
    return (
      <div className="details">
        <p className="muted">シナリオ「{name}」が見つかりません。ほかのところ（AI など）で名前が変わったか、消された可能性があります。グラフの上の凡例から選び直してください。</p>
        <div className="form-buttons">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    );
  }

  const scenarios = model.scenarios ?? [];
  const index = scenario ? scenarios.indexOf(scenario) : scenarios.length;
  // 名前のないシナリオの「scenario N」の番号は、元の並びで付ける
  const others = scenarios.map(scenarioName).filter((_, i) => scenarios[i] !== scenario);
  const targets = valueTargets(model);

  const setRow = (i: number, row: Partial<ValueRow>) => setForm((f) => ({ ...f, rows: f.rows.map((r, j) => (j === i ? { ...r, ...row } : r)) }));
  const addRow = () => setForm((f) => ({ ...f, rows: [...f.rows, { element: "", value: "" }] }));
  const removeRow = (i: number) => setForm((f) => ({ ...f, rows: f.rows.filter((_, j) => j !== i) }));

  const save = async () => {
    const latest = scenarioFormOf(scenario, name, model);
    if (JSON.stringify(latest) !== JSON.stringify(base)) {
      // 編集しているあいだに、このシナリオがほかで変わった。黙って上書きせず、一度知らせる
      setBase(latest);
      setError("編集しているあいだに、ほかのところ（AI など）でこのシナリオが変わりました。グラフの上の凡例で、いまの内容を確かめられます。もう一度「保存」を押すと、この欄の内容で上書きします。");
      return;
    }
    let patch: ScenarioPatch | undefined;
    try {
      patch = scenarioPatchOf(name, base, form, others);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!patch) {
      onClose();
      return;
    }
    setSaving(true);
    resync.current = true;
    const err = await onSave(patch);
    setSaving(false);
    if (err) {
      resync.current = false;
      setError(err);
    } else setError(undefined);
  };
  const remove = async () => {
    if (name === undefined) return;
    setSaving(true);
    const err = await onRemove(name);
    setSaving(false);
    setConfirming(false);
    if (err) setError(err);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // 消す確かめのあいだは、Esc で確かめだけをやめ、Ctrl+Enter では保存しない
    if (confirming) {
      if (e.key === "Escape") setConfirming(false);
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  // 表で選べる要素。表にある要素は、選べない種類やモデルにない名前でも残す（消さずに直せるように）
  const optionsFor = (current: string) => {
    const names = targets.map((t) => t.name!);
    return current && !names.some((n) => n.toLowerCase() === current.toLowerCase()) ? [current, ...names] : names;
  };
  const typeOf = (n: string) => targets.find((t) => t.name!.toLowerCase() === n.toLowerCase())?.type;
  const used = new Set(form.rows.map((r) => r.element.trim().toLowerCase()).filter(Boolean));

  return (
    <div className="details" onKeyDown={onKeyDown}>
      <div className="details-head">
        <span className="type-badge">シナリオ</span>
        <strong>{name ?? "新しいシナリオ"}</strong>
      </div>
      <div className="form">
        <label>
          <span>名前</span>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="広告を増やす" autoFocus={name === undefined} />
        </label>
        <label>
          <span>説明（どんなシナリオか）</span>
          <textarea rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </label>
        <div className="scenario-values">
          <span className="scenario-values-label">変える値</span>
          {form.rows.length > 0 ? (
            <table className="scenario-table">
              <thead>
                <tr>
                  <th>要素</th>
                  <th>このシナリオ</th>
                  <th title={`${BASELINE_NAME}の値（いまのモデルの値）`}>いま</th>
                  <th aria-label="行を消す" />
                </tr>
              </thead>
              <tbody>
                {form.rows.map((r, i) => {
                  const type = typeOf(r.element);
                  const now = r.element ? currentValueOf(model, r.element) : undefined;
                  return (
                    <tr key={i}>
                      <td>
                        <select value={r.element} onChange={(e) => setRow(i, { element: e.target.value })} aria-label={`${i + 1} 行目の要素`}>
                          <option value="">選ぶ…</option>
                          {optionsFor(r.element).map((n) => (
                            <option key={n} value={n} disabled={n !== r.element && used.has(n.toLowerCase())}>
                              {n}
                            </option>
                          ))}
                        </select>
                        {type && <small className="muted">{TYPE_LABEL[type]}{type === "STOCK" ? "の初期値" : ""}</small>}
                      </td>
                      <td>
                        <input className="code" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} aria-label={`${r.element || `${i + 1} 行目`} のこのシナリオの値`} />
                      </td>
                      <td className="code muted" title={now}>
                        {now ?? "—"}
                      </td>
                      <td>
                        <button className="legend-remove" onClick={() => removeRow(i)} aria-label={`${r.element || `${i + 1} 行目`} の行を消す`} title="この行を消す">
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="muted small">まだ値を変えていません。このままだと「{BASELINE_NAME}」と同じ結果になります。</p>
          )}
          <button className="link" onClick={addRow}>
            ＋ 行を足す
          </button>
          <small className="muted">値は数字か式で入れます。他の要素は [名前] で参照します。</small>
        </div>
        {index >= MAX_SERIES && (
          <p className="form-note">
            グラフに重ねられるシナリオは {MAX_SERIES} つまでです。このシナリオは {index + 1} つ目なので、保存してもグラフには出ません。
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        {confirming ? (
          <div className="form-buttons confirm">
            <span>シナリオ「{name}」を消しますか？</span>
            <button className="danger" onClick={() => void remove()} disabled={saving}>
              消す
            </button>
            <button onClick={() => setConfirming(false)} disabled={saving}>
              やめる
            </button>
          </div>
        ) : (
          <div className="form-buttons">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存しています…" : "保存"}
            </button>
            <button onClick={onClose} disabled={saving}>
              やめる
            </button>
            <span className="muted small">Ctrl+Enter で保存</span>
          </div>
        )}
        {name !== undefined && !confirming && (
          <button className="link danger-link" onClick={() => setConfirming(true)} disabled={saving}>
            このシナリオを消す
          </button>
        )}
      </div>
    </div>
  );
}
