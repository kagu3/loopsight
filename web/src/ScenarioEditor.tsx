import { useEffect, useRef, useState } from "react";
import type { BaselinePatch, ModelJSON, ScenarioPatch } from "../../src/viewer/api.js";
import { baselineOf } from "../../src/core/modeljson.js";
import { baselineDescriptionPatchOf, descriptionAfterSave, descriptionPatchOf, findScenario } from "./scenarios.js";

// シナリオの説明の編集欄。表の見出しのシナリオの名前を押して出る吹き出しの「説明を直す」で、左の欄に出す（要素の「編集」と同じ場所）。
// 説明は凡例にカーソルを乗せたときに出る文で、ここで直す。名前・値・シナリオを足す・消すは、シナリオの中身の表で直す。
// 変更は MCP の set_scenarios と同じ形（説明だけ）でサーバーに送る。
// 何も変えない実行（baseline）の説明も、ここで直す（set_scenarios の baseline）。

export interface ScenarioEditorProps {
  model: ModelJSON;
  /** 説明を直すシナリオの名前（何も変えない実行なら、その名前） */
  name: string;
  /** 何も変えない実行の説明を直す */
  baseline?: boolean;
  /** 保存する。失敗したらエラーの文を返す */
  onSave(patch: ScenarioPatch): Promise<string | undefined>;
  /** 何も変えない実行の説明を保存する。失敗したらエラーの文を返す */
  onSaveBaseline?(patch: BaselinePatch): Promise<string | undefined>;
  /** 編集欄を閉じる */
  onClose(): void;
}

export function ScenarioEditor({ model, name, baseline: isBaseline = false, onSave, onSaveBaseline, onClose }: ScenarioEditorProps) {
  // いまのモデルの説明（何も変えない実行はいつもある。シナリオが見つからなければ found が false）。
  // 描くたびに作り直すオブジェクトではなく文字で持ち、下の effect が説明の変わったときだけ動くようにする
  const scenario = isBaseline ? undefined : findScenario(model, name);
  const found = isBaseline || !!scenario;
  const latest = (isBaseline ? baselineOf(model).description : scenario?.description) ?? "";
  const [description, setDescription] = useState(latest);
  // 編集を始めたときの説明。保存するときに、そのあいだに AI などがこの説明を変えていないか比べる
  const [base, setBase] = useState(latest);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 保存したら、保存した中身で欄を作り直す（保存する前の版で描き直したときは、まだ待つ）
  const resync = useRef(false);
  useEffect(() => {
    const next = descriptionAfterSave(resync.current, base, latest);
    resync.current = next.waiting;
    if (next.reset === undefined) return;
    setDescription(next.reset);
    setBase(next.reset);
  }, [latest]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!found && !saving) {
    return (
      <div className="details">
        <p className="muted">シナリオ「{name}」が見つかりません。ほかのところ（AI など）で名前が変わったか、消された可能性があります。表の見出しのシナリオの名前から選び直してください。</p>
        <div className="form-buttons">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    );
  }

  const save = async () => {
    if (latest !== base) {
      // 編集しているあいだに、この説明がほかで変わった。黙って上書きせず、一度知らせる
      setBase(latest);
      setError(`編集しているあいだに、ほかのところ（AI など）でこの${isBaseline ? "" : "シナリオの"}説明が変わりました。表の見出しにカーソルを乗せると、いまの説明を確かめられます。もう一度「保存」を押すと、この欄の内容で上書きします。`);
      return;
    }
    let save: (() => Promise<string | undefined>) | undefined;
    if (isBaseline) {
      const patch = baselineDescriptionPatchOf(base, description);
      if (patch && onSaveBaseline) save = () => onSaveBaseline(patch);
    } else {
      const patch = descriptionPatchOf(name, base, description);
      if (patch) save = () => onSave(patch);
    }
    if (!save) {
      onClose();
      return;
    }
    setSaving(true);
    resync.current = true;
    const err = await save();
    setSaving(false);
    if (err) {
      resync.current = false;
      setError(err);
    } else setError(undefined);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="details" onKeyDown={onKeyDown}>
      <div className="details-head">
        <span className="type-badge">{isBaseline ? "何も変えない実行" : "シナリオ"}</span>
        <strong>{name}</strong>
      </div>
      <div className="form">
        <label>
          <span>{isBaseline ? "説明（何を表す線か。凡例にカーソルを乗せると出ます）" : "説明（どんなシナリオか。凡例にカーソルを乗せると出ます）"}</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} autoFocus />
        </label>
        <small className="muted">{isBaseline ? "名前は、グラフの上の凡例（表の見出し）の名前を押して直します。" : "名前と値は、グラフの上の表（「▸ 中身を見る」）で直します。"}</small>
        {error && <p className="form-error">{error}</p>}
        <div className="form-buttons">
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存しています…" : "保存"}
          </button>
          <button onClick={onClose} disabled={saving}>
            やめる
          </button>
          <span className="muted small">Ctrl+Enter で保存</span>
        </div>
      </div>
    </div>
  );
}
