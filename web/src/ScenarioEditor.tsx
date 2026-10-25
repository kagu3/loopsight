import { useEffect, useRef, useState } from "react";
import type { ModelJSON, ScenarioPatch } from "../../src/viewer/api.js";
import { descriptionPatchOf, findScenario } from "./scenarios.js";

// シナリオの説明の編集欄。表の見出しのシナリオの名前を押して出る吹き出しの「説明を直す」で、左の欄に出す（要素の「編集」と同じ場所）。
// 説明は凡例にカーソルを乗せたときに出る文で、ここで直す。名前・値・シナリオを足す・消すは、シナリオの中身の表で直す。
// 変更は MCP の set_scenarios と同じ形（説明だけ）でサーバーに送る。

export interface ScenarioEditorProps {
  model: ModelJSON;
  /** 説明を直すシナリオの名前 */
  name: string;
  /** 保存する。失敗したらエラーの文を返す */
  onSave(patch: ScenarioPatch): Promise<string | undefined>;
  /** 編集欄を閉じる */
  onClose(): void;
}

export function ScenarioEditor({ model, name, onSave, onClose }: ScenarioEditorProps) {
  const scenario = findScenario(model, name);
  const [description, setDescription] = useState(() => scenario?.description ?? "");
  // 編集を始めたときの説明。保存するときに、そのあいだに AI などがこの説明を変えていないか比べる
  const [base, setBase] = useState(() => scenario?.description ?? "");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // 保存したら、保存した中身で欄を作り直す
  const resync = useRef(false);
  useEffect(() => {
    if (!resync.current) return;
    resync.current = false;
    setDescription(scenario?.description ?? "");
    setBase(scenario?.description ?? "");
  }, [scenario]);

  if (!scenario && !saving) {
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
    const latest = scenario?.description ?? "";
    if (latest !== base) {
      // 編集しているあいだに、この説明がほかで変わった。黙って上書きせず、一度知らせる
      setBase(latest);
      setError("編集しているあいだに、ほかのところ（AI など）でこのシナリオの説明が変わりました。表の見出しにカーソルを乗せると、いまの説明を確かめられます。もう一度「保存」を押すと、この欄の内容で上書きします。");
      return;
    }
    const patch = descriptionPatchOf(name, base, description);
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
        <span className="type-badge">シナリオ</span>
        <strong>{name}</strong>
      </div>
      <div className="form">
        <label>
          <span>説明（どんなシナリオか。凡例にカーソルを乗せると出ます）</span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} autoFocus />
        </label>
        <small className="muted">名前と値は、グラフの上の表（「▸ 中身を見る」）で直します。</small>
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
