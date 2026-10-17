// 値と時刻の書き方（React に依存しない）。グラフのツールチップ・表・図で同じ丸め方にする。

export function formatValue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-3)) return v.toExponential(3);
  return v.toLocaleString("ja-JP", { maximumFractionDigits: abs >= 100 ? 2 : 4 });
}

/** 時刻は桁区切りなし（2014.5 年のように） */
export function formatTime(t: number | null | undefined): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return "—";
  return t.toLocaleString("ja-JP", { useGrouping: false, maximumFractionDigits: 4 });
}
