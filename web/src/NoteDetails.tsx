import { useEffect, useState } from "react";
import type { Annotation } from "../../src/core/modeljson.js";
import type { AnnotationPatch } from "../../src/viewer/api.js";

// 選んだ注釈（どこにもつながらない文字だけのもの）の文字と、その編集。
// 編集は MCP の set_annotations と同じ形でサーバーに送る。動かす・消すのは図の編集モードで行う。

export interface NoteDetailsProps {
  note: Annotation;
  /** 編集モードか（消し方の案内を変える） */
  editMode: boolean;
  /** 保存する。失敗したらエラーの文を返す */
  onSave(patch: AnnotationPatch): Promise<string | undefined>;
}

export function NoteDetails({ note, editMode, onSave }: NoteDetailsProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  // 編集を始めたときの文字。保存するときに、そのあいだに AI などがこの注釈を変えていないか比べる
  const [base, setBase] = useState(note.text);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  // 別の注釈を選んだら編集をやめる。同じ注釈が AI などに変えられたら、編集中でなければ表示を合わせる
  useEffect(() => {
    setEditing(false);
    setError(undefined);
  }, [note.id]);
  useEffect(() => {
    if (!editing) {
      setText(note.text);
      setBase(note.text);
    }
  }, [note.text, editing]);

  const stop = () => {
    setEditing(false);
    setError(undefined);
  };
  const save = async () => {
    if (note.text !== base) {
      // 編集しているあいだに、この注釈がほかで変わった。黙って上書きせず、一度知らせる
      setBase(note.text);
      setError(`編集しているあいだに、ほかのところ（AI など）でこの注釈が変わりました（いまの文字: ${note.text}）。もう一度「保存」を押すと、この欄の内容で上書きします。`);
      return;
    }
    if (!text.trim()) {
      setError("文字が空です。注釈を消すときは、図の編集モードで「削除」を押します。");
      return;
    }
    if (text.trim() === note.text) return stop();
    setSaving(true);
    const err = await onSave({ id: note.id, text });
    setSaving(false);
    if (err) setError(err);
    else stop();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") stop();
  };

  const head = (
    <div className="details-head">
      <span className="type-badge type-note">注釈</span>
      <strong>{note.id}</strong>
      {!editing && (
        <button className="small-button" onClick={() => setEditing(true)}>
          編集
        </button>
      )}
    </div>
  );

  if (editing) {
    return (
      <div className="details" onKeyDown={onKeyDown}>
        {head}
        <div className="form">
          <label>
            <span>文字</span>
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <small className="muted">決まった幅で折り返します。改行で行を分けられます。</small>
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-buttons">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存しています…" : "保存"}
            </button>
            <button onClick={stop} disabled={saving}>
              やめる
            </button>
            <span className="muted small">Ctrl+Enter で保存</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="details">
      {head}
      <p className="note-text">{note.text}</p>
      <p className="muted small">
        図の説明のための文字で、シミュレーションには使いません。
        {editMode ? "ドラッグで動かせます。「削除」か Delete キーで消せます。" : "動かす・消すときは、図の左上の「図を編集」をオンにします。"}
      </p>
    </div>
  );
}
