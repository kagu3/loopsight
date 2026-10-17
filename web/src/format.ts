// 値と時刻の書き方（React に依存しない）。グラフのツールチップ・表・図で同じ丸め方にする。
// 値の書き方は export_slides の slides.md とも同じものを使うため、src/core/format.ts に置いてある。

export { formatValue } from "../../src/core/format.js";

/** 時刻は桁区切りなし（2014.5 年のように） */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "—";
  return t.toLocaleString("ja-JP", { useGrouping: false, maximumFractionDigits: 4 });
}
