// 説明資料で見せる値の計算と丸め方（作業画面の値の書き方 formatValue もここに置く）。発表モードの比較スライド（web）と、export_slides の slides.md（サーバー）で同じものを使い、
// 画面と書き出したファイルで値がずれないようにする。画面からも読むので、ほかのものを import しない。

/**
 * 読みやすく丸めた値。1,000 以上は整数に、それより小さい値は上から 4 桁にする（2,691.59 → 2,692、12.345 → 12.35）。
 * 桁区切りを付ける。負の数の符号は changeFrom と同じ「−」。数でなければ「—」
 */
export function formatReadable(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = Math.abs(v) >= 1000 ? v.toLocaleString("ja-JP", { maximumFractionDigits: 0 }) : v.toLocaleString("ja-JP", { maximumSignificantDigits: 4 });
  return s.replace(/^-/, "−");
}

/** 作業画面のグラフや表の値（100 以上は小数 2 桁まで、それより小さい値は 4 桁まで）。発表モードの解決案の値と、slides.md の同じ表にも使う */
export function formatValue(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-3)) return v.toExponential(3);
  return v.toLocaleString("ja-JP", { maximumFractionDigits: abs >= 100 ? 2 : 4 });
}

/** 時刻 t の値。刻みの間は前後の値から直線で補う。範囲の外や値のないところは null */
export function valueAt(times: number[], values: (number | null)[] | undefined, t: number): number | null {
  if (!values || times.length === 0) return null;
  const eps = 1e-9 * Math.max(1, Math.abs(t));
  if (t < times[0]! - eps || t > times.at(-1)! + eps) return null;
  const j = times.findIndex((x) => x >= t - eps);
  if (Math.abs(times[j]! - t) <= eps) return values[j] ?? null;
  const a = values[j - 1];
  const b = values[j];
  if (a == null || b == null) return null;
  return a + ((b - a) * (t - times[j - 1]!)) / (times[j]! - times[j - 1]!);
}

/** 「元のモデル」と比べた変化（+12% / −39%）。比べられなければ空文字 */
export function changeFrom(base: number | null, value: number | null): string {
  if (base === null || value === null || base === 0) return "";
  const p = ((value - base) / Math.abs(base)) * 100;
  const r = Math.round(p);
  if (r === 0) return "±0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}
