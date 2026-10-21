import { useEffect, useId, useRef, useState } from "react";

/**
 * 「i」アイコン。押すと説明文を出す（カーソルを乗せたときは、ツールチップで出す）。
 * 上の帯を 1 行に収めるため、長い説明文は帯に並べずにこのアイコンにしまう。画面の大きさにかかわらず、いつもアイコンで出す。
 * 読み上げでは、アイコンの名前として説明文の全文を読む。
 */
export function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  // 外を押したら閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <span
      className="info-tip"
      ref={rootRef}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
      onBlur={(e) => {
        // Tab でほかへ移ったら閉じる（説明文の中を押したときは移り先がないので閉じない）
        if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        className="info-button"
        aria-label={text}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        // 開いている間は、ブラウザのツールチップを重ねて出さない
        title={open ? undefined : text}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">i</span>
      </button>
      {open && (
        <span id={popoverId} className="info-popover" role="note">
          {text}
        </span>
      )}
    </span>
  );
}
