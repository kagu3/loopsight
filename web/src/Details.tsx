import { useEffect, useState } from "react";
import type { ElementPatch, ModelElement } from "../../src/viewer/api.js";

// 選んだ要素の詳しい情報と、その編集（E1）。
// 編集は MCP の upsert_elements と同じ形（変えた項目だけ）でサーバーに送る。

const TYPE_LABEL: Record<string, string> = {
  STOCK: "ストック",
  FLOW: "フロー",
  VARIABLE: "変数",
  CONVERTER: "コンバーター",
  STATE: "状態",
  TRANSITION: "遷移",
};

/** 編集できる種類。状態と遷移は段階 1 と同じく編集しない */
const EDITABLE = new Set(["STOCK", "FLOW", "VARIABLE", "CONVERTER"]);

/** 数字だけなら数値、それ以外は式の文字列 */
export function parseEquation(text: string): string | number {
  const t = text.trim();
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : t;
}

/** コンバーターの表。1 行に「入力, 出力」 */
export function parseTable(text: string): [number, number][] {
  const rows: [number, number][] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parts = line.split(/[,\t]/).map((x) => x.trim());
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`表の ${i + 1} 行目「${line}」が読めません。「入力, 出力」の形で書いてください。`);
    }
    rows.push([x, y]);
  }
  if (!rows.length) throw new Error("表が空です。");
  return rows;
}

const tableText = (data: unknown) => (Array.isArray(data) ? (data as [number, number][]).map(([x, y]) => `${x}, ${y}`).join("\n") : "");

interface Form {
  equation: string;
  table: string;
  units: string;
  nonNegative: boolean;
  description: string;
}

function formOf(el: ModelElement): Form {
  const b = el.behavior ?? {};
  const eq = el.type === "STOCK" ? b.initial_value : b.value;
  return {
    equation: eq === undefined ? "" : String(eq),
    table: tableText(b.data),
    units: b.units ? String(b.units) : "",
    nonNegative: !!b.non_negative,
    description: el.description ?? "",
  };
}

/** フォームと元の要素を比べて、変えた項目だけの変更にする */
export function patchOf(el: ModelElement, before: Form, after: Form): ElementPatch | undefined {
  const behavior: Record<string, unknown> = {};
  const patch: ElementPatch = { name: el.name! };
  if (el.type !== "CONVERTER" && after.equation.trim() !== before.equation.trim()) {
    if (!after.equation.trim()) throw new Error(el.type === "STOCK" ? "初期値が空です。" : "式が空です。");
    behavior[el.type === "STOCK" ? "initial_value" : "value"] = parseEquation(after.equation);
  }
  if (el.type === "CONVERTER" && after.table.trim() !== before.table.trim()) behavior.data = parseTable(after.table);
  if (after.units.trim() !== before.units.trim()) behavior.units = after.units.trim() || null;
  if ((el.type === "STOCK" || el.type === "FLOW") && after.nonNegative !== before.nonNegative) behavior.non_negative = after.nonNegative || null;
  if (Object.keys(behavior).length) patch.behavior = behavior;
  if (after.description.trim() !== before.description.trim()) patch.description = after.description.trim() || null;
  return Object.keys(patch).length > 1 ? patch : undefined;
}

export interface DetailsProps {
  el: ModelElement;
  value?: string;
  /** 保存する。失敗したらエラーの文を返す */
  onSave(patch: ElementPatch): Promise<string | undefined>;
}

export function Details({ el, value, onSave }: DetailsProps) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Form>(() => formOf(el));
  // 編集を始めたときの値。保存するときに、そのあいだに AI などがこの要素を変えていないか比べる
  const [base, setBase] = useState<Form>(() => formOf(el));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // 別の要素を選んだら編集をやめる。同じ要素が AI などに変えられたら、編集中でなければ表示を合わせる
  useEffect(() => {
    setEditing(false);
    setError(undefined);
  }, [el.name]);
  useEffect(() => {
    if (!editing) {
      setForm(formOf(el));
      setBase(formOf(el));
    }
  }, [el, editing]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const latest = formOf(el);
    if (JSON.stringify(latest) !== JSON.stringify(base)) {
      // 編集しているあいだに、この要素がほかで変わった。黙って上書きせず、一度知らせる
      setBase(latest);
      setError(
        `編集しているあいだに、ほかのところ（AI など）でこの要素が変わりました（いまの${el.type === "STOCK" ? "初期値" : "式"}: ${
          el.type === "CONVERTER" ? latest.table.replace(/\n/g, " / ") : latest.equation || "なし"
        }）。もう一度「保存」を押すと、この欄の内容で上書きします。`,
      );
      return;
    }
    let patch: ElementPatch | undefined;
    try {
      patch = patchOf(el, latest, form);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    if (!patch) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const err = await onSave(patch);
    setSaving(false);
    if (err) setError(err);
    else {
      setError(undefined);
      setEditing(false);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      setEditing(false);
      setError(undefined);
    }
  };

  const b = el.behavior ?? {};
  const head = (
    <div className="details-head">
      <span className={`type-badge type-${el.type.toLowerCase()}`}>{TYPE_LABEL[el.type] ?? el.type}</span>
      <strong>{el.name}</strong>
      {EDITABLE.has(el.type) && !editing && (
        <button className="small-button" onClick={() => setEditing(true)}>
          編集
        </button>
      )}
    </div>
  );

  if (editing) {
    const eqLabel = el.type === "STOCK" ? "初期値" : el.type === "FLOW" ? "流量" : "式";
    return (
      <div className="details" onKeyDown={onKeyDown}>
        {head}
        <div className="form">
          {el.type === "CONVERTER" ? (
            <label>
              <span>表（1 行に「入力, 出力」）</span>
              <textarea className="code" rows={6} value={form.table} onChange={(e) => set("table", e.target.value)} autoFocus />
            </label>
          ) : (
            <label>
              <span>{eqLabel}</span>
              <textarea className="code" rows={3} value={form.equation} onChange={(e) => set("equation", e.target.value)} autoFocus />
              <small className="muted">他の要素は [名前] で参照します。数字だけなら数値として保存します。</small>
            </label>
          )}
          <label>
            <span>単位</span>
            <input value={form.units} onChange={(e) => set("units", e.target.value)} placeholder="なし" />
          </label>
          {(el.type === "STOCK" || el.type === "FLOW") && (
            <label className="check">
              <input type="checkbox" checked={form.nonNegative} onChange={(e) => set("nonNegative", e.target.checked)} />
              負にしない
            </label>
          )}
          <label>
            <span>説明</span>
            <textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-buttons">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存しています…" : "保存"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setError(undefined);
              }}
              disabled={saving}
            >
              やめる
            </button>
            <span className="muted small">Ctrl+Enter で保存</span>
          </div>
        </div>
      </div>
    );
  }

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
      {head}
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
