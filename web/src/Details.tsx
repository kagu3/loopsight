import { useEffect, useState } from "react";
import type { ElementPatch, ModelElement } from "../../src/viewer/api.js";
import { hasDelayMark } from "../../src/core/delay.js";
import { formOf, patchOf, type Form } from "./editing.js";

// 選んだ要素の詳しい情報と、その編集（E1）。「編集」の中で名前も変えられる（E3）。
// 編集は MCP の upsert_elements と同じ形（変えた項目だけ）でサーバーに送る。
// 図の箱になる要素は、「図で強調する」で強調の印（display.emphasis）を付け外しできる（押すとすぐ保存する）。
// フローと、選んだリンク（App.tsx）には、遅れの印（‖）を付け外しするチェックを出す（押すとすぐ保存する。MCP の display.delay と同じ）。
// 選んだリンクには、極性（+ / −）を選ぶ欄も出す（押すとすぐ保存する。MCP の LINK の behavior.polarity と同じ）。

const TYPE_LABEL: Record<string, string> = {
  STOCK: "ストック",
  FLOW: "フロー",
  VARIABLE: "変数",
  CONVERTER: "コンバーター",
};

/** 編集できる種類（図の箱になる要素とフロー） */
const EDITABLE = new Set(["STOCK", "FLOW", "VARIABLE", "CONVERTER"]);
/** 強調できる種類（図の箱になる要素。core の BOX_TYPES と同じ） */
const EMPHASIZABLE = new Set(["STOCK", "VARIABLE", "CONVERTER"]);

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
        `編集しているあいだに、ほかのところ（AI など）でこの要素が変わりました（${latest.name !== base.name ? `いまの名前: ${latest.name}、` : ""}いまの${el.type === "STOCK" ? "初期値" : "式"}: ${
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

  // 強調の印を付け外しする。式などの編集とは別に、押すとすぐ保存する（false はサーバーが項目を消す）
  const toggleEmphasis = async (on: boolean) => {
    setSaving(true);
    const err = await onSave({ name: el.name!, display: { emphasis: on } });
    setSaving(false);
    setError(err);
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
          <label>
            <span>名前</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} />
            <small className="muted">変えると、ほかの要素の式やシナリオの中の名前も書き換えます。</small>
          </label>
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
  if (el.type === "FLOW") rows.push(["流れ", `${el.from ?? "（外）"} → ${el.to ?? "（外）"}`]);
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
      {EMPHASIZABLE.has(el.type) && (
        <label className="emphasis-toggle" title="説明のときに見てほしい要素を、図で大きく描きます（箱・名前の文字・枠の太さ）。シミュレーションには影響しません">
          <input type="checkbox" checked={el.display?.emphasis === true} disabled={saving} onChange={(e) => void toggleEmphasis(e.target.checked)} />
          図で強調する（大きく描く）
        </label>
      )}
      {error && <p className="form-error">{error}</p>}
      {el.type === "FLOW" && <DelayToggle key={el.name} on={hasDelayMark(el)} onChange={(on) => onSave({ name: el.name, display: { delay: on } })} />}
    </div>
  );
}

/**
 * 遅れの印（‖）を付け外しするチェック。押すとすぐ保存する。
 * 印は図の見た目だけで、シミュレーションには影響しないことを添える
 */
export function DelayToggle({ on, onChange }: { on: boolean; onChange(on: boolean): Promise<string | undefined> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const toggle = async (next: boolean) => {
    setSaving(true);
    const err = await onChange(next);
    setSaving(false);
    setError(err);
  };
  return (
    <span className="delay-toggle">
      <label className="check" title="図の線の途中に ‖ を描いて、時間がたってから効くことを見せます。見た目だけで、シミュレーションには影響しません（実際の遅れは式の Delay などで表します）">
        <input type="checkbox" checked={on} disabled={saving} onChange={(e) => void toggle(e.target.checked)} />
        遅れの印（‖）を付ける
      </label>
      {error && <span className="form-error">{error}</span>}
    </span>
  );
}

/** リンクの極性。null は決めない（項目を消す） */
export type LinkPolarity = "POSITIVE" | "NEGATIVE" | null;

const POLARITY_CHOICES: { value: LinkPolarity; label: string; title: string }[] = [
  { value: "POSITIVE", label: "+", title: "元が増えると、先も増える（元が減ると、先も減る）" },
  { value: "NEGATIVE", label: "−", title: "元が増えると、先は減る（元が減ると、先は増える）" },
  { value: null, label: "なし（決めない）", title: "極性を決めません。このリンクを通るループは、R か B か決まりません" },
];

/** リンクの極性（behavior.polarity）。POSITIVE と NEGATIVE のほか（NEUTRAL やないもの）は、決めていないとみなす */
export function linkPolarity(el: ModelElement): LinkPolarity {
  const p = el.behavior?.polarity;
  return p === "POSITIVE" || p === "NEGATIVE" ? p : null;
}

/**
 * リンクの極性（+ / −）を選ぶ欄。押すとすぐ保存する。
 * 極性で、ループが強める（R）か釣り合わせる（B）かが決まる
 */
export function PolarityPicker({ value, onChange }: { value: LinkPolarity; onChange(value: LinkPolarity): Promise<string | undefined> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const choose = async (next: LinkPolarity) => {
    setSaving(true);
    const err = await onChange(next);
    setSaving(false);
    setError(err);
  };
  return (
    <span className="polarity-picker">
      <span
        className="polarity-choices"
        role="radiogroup"
        aria-label="極性"
        title="元が増えたときに先が増えるなら +、減るなら − です。ループの − の数が偶数なら強めるループ（R）、奇数なら釣り合わせるループ（B）になります"
      >
        <span className="polarity-label">極性</span>
        {POLARITY_CHOICES.map((c) => (
          <label key={c.label} className="check" title={c.title}>
            <input type="radio" name="link-polarity" value={c.value ?? "none"} checked={value === c.value} disabled={saving} onChange={() => void choose(c.value)} />
            {c.label}
          </label>
        ))}
      </span>
      {error && <span className="form-error">{error}</span>}
    </span>
  );
}
