import { useEffect, useState } from "react";
import type { ModelJSON, SimulationSettings } from "../../src/viewer/api.js";
import { TIME_UNITS } from "../../src/core/modeljson.js";
import { ALGORITHM_LABEL, describeSimulation, rebaseSimulationForm, sameSimulationForm, savedSimulationForm, simulationFormOf, simulationPatchOf, unitLabelOf, type SimulationErrors, type SimulationForm } from "./simulation.js";

// シミュレーションの設定（開始時刻、期間、刻み幅、解法、時間の単位）の編集欄。グラフの上の帯の期間のボタンを押して、左の欄に出す（要素の「編集」と同じ場所）。
// 値の編集と同じく、「図を編集」に関係なく直せる。保存するとすぐ実行し直し、グラフと図の値が変わる。元に戻すでも戻せる。
// 変更は MCP の set_simulation と同じ形（変えた項目だけ）でサーバーに送り、同じ確かめ（core の simulationIssues）を通す。誤りは欄の近くに出して保存しない。

export interface SimulationEditorProps {
  model: ModelJSON;
  /** 保存する。失敗したらエラーの文を返す */
  onSave(patch: SimulationSettings): Promise<string | undefined>;
  /** 編集欄を閉じる */
  onClose(): void;
}

export function SimulationEditor({ model, onSave, onClose }: SimulationEditorProps) {
  const latest = simulationFormOf(model.simulation);
  const [form, setForm] = useState<SimulationForm>(latest);
  // 編集を始めた（または前に保存した）ときの設定。保存するときに、そのあいだに AI などが設定を変えていないか比べる
  const [base, setBase] = useState<SimulationForm>(latest);
  const [errors, setErrors] = useState<SimulationErrors>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const touched = !sameSimulationForm(form, base);
  useEffect(() => {
    // まだ何も変えていなければ、ほかで変わった設定（AI の変更や「元に戻す」）をそのまま欄に出す。前の誤りも消す
    if (touched) return;
    setForm(latest);
    setBase(latest);
    setErrors({});
    setError(undefined);
  }, [model.simulation]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof SimulationForm>(k: K, v: SimulationForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    // 直した欄の誤りは消す（ほかの欄の誤りは、もう一度「保存」を押すまで残す）
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  const save = async () => {
    if (!sameSimulationForm(latest, base)) {
      // 編集しているあいだに、設定がほかで変わった。黙って上書きせず、一度知らせる。
      // 人が直していない項目は、いまの設定に入れ替える（もう一度保存したときに、ほかで変えた項目を消さないように）
      setForm(rebaseSimulationForm(form, base, latest));
      setBase(latest);
      setError(`編集しているあいだに、ほかのところ（AI など）でシミュレーションの設定が変わりました（いまは ${describeSimulation(model.simulation)}）。直していない欄は、いまの設定にしました。もう一度「保存」を押すと、直した欄だけを上書きします。`);
      return;
    }
    const { patch, errors: found } = simulationPatchOf(base, form);
    setErrors(found);
    if (Object.keys(found).length) {
      setError(undefined);
      return;
    }
    if (!patch) {
      onClose();
      return;
    }
    const before = model.simulation;
    setSaving(true);
    const err = await onSave(patch);
    setSaving(false);
    if (err) {
      // 書きかけの内容は残す
      setError(err);
      return;
    }
    // 保存できたときだけ、保存した中身で欄を作り直す（直していない欄になるので、このあとの AI の変更なども欄に出る）
    const saved = savedSimulationForm(before, patch);
    setForm(saved);
    setBase(saved);
    setError(undefined);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const unit = unitLabelOf(form.time_units);
  const field = (k: "time_start" | "time_length" | "time_step", label: string, autoFocus = false) => (
    <label>
      <span>{label}</span>
      <input inputMode="decimal" value={form[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={!!errors[k]} autoFocus={autoFocus} />
      {errors[k] && <span className="form-error">{errors[k]}</span>}
    </label>
  );

  return (
    <div className="details" onKeyDown={onKeyDown}>
      <div className="details-head">
        <span className="type-badge">設定</span>
        <strong>シミュレーションの設定</strong>
      </div>
      <div className="form">
        {field("time_start", `開始時刻（${unit}）`, true)}
        {field("time_length", `期間（${unit}。開始からどれだけ進めるか）`)}
        {field("time_step", `刻み幅（${unit}。小さいほど細かく計算します）`)}
        <label>
          <span>時間の単位</span>
          <select value={form.time_units} onChange={(e) => set("time_units", e.target.value as SimulationForm["time_units"])} aria-invalid={!!errors.time_units}>
            {TIME_UNITS.map((u) => (
              <option key={u} value={u}>
                {unitLabelOf(u)}（{u}）
              </option>
            ))}
          </select>
          {errors.time_units && <span className="form-error">{errors.time_units}</span>}
        </label>
        <label>
          <span>解法</span>
          <select value={form.algorithm} onChange={(e) => set("algorithm", e.target.value as SimulationForm["algorithm"])} aria-invalid={!!errors.algorithm}>
            {(["RK1", "RK4"] as const).map((a) => (
              <option key={a} value={a}>
                {ALGORITHM_LABEL[a]}
              </option>
            ))}
          </select>
          {errors.algorithm && <span className="form-error">{errors.algorithm}</span>}
        </label>
        <small className="muted">保存するとすぐ実行し直し、グラフと図の値が変わります。「元に戻す」（Ctrl+Z）で戻せます。</small>
        {error && <p className="form-error">{error}</p>}
        <div className="form-buttons">
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存しています…" : "保存"}
          </button>
          <button onClick={onClose} disabled={saving}>
            閉じる
          </button>
          <span className="muted small">Ctrl+Enter で保存</span>
        </div>
      </div>
    </div>
  );
}
