// 値と時刻の書き方と、時間の単位の名前（React に依存しない）。グラフのツールチップ・表・図で同じ丸め方にする。

/** 作業画面のグラフや表の値（100 以上は小数 2 桁まで、それより小さい値は 4 桁まで） */
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

/** 時間の単位の名前（キーは小文字。実行結果の time_units も、モデルの time_units を小文字にしたものも引ける） */
export const TIME_UNIT_LABEL: Record<string, string> = {
  seconds: "秒",
  minutes: "分",
  hours: "時間",
  days: "日",
  weeks: "週",
  months: "月",
  years: "年",
};
