// 図と下の欄（グラフ・表）の高さの分け方。React に依存しない（テストから直接使う）

/** 下の欄の高さの割合（右側の欄の高さに対して）のはじめの値 */
export const RESULTS_RATIO = 0.38;
/** これより低くしない高さ（px） */
export const MIN_DIAGRAM_HEIGHT = 240;
export const MIN_RESULTS_HEIGHT = 220;

/** 覚えておいた割合を読む。読めない値なら、はじめの値 */
export function parseResultsRatio(text: string | null): number {
  const v = Number(text);
  return text !== null && Number.isFinite(v) && v > 0 && v < 1 ? v : RESULTS_RATIO;
}

/**
 * 境界線を dy（px、下向きが正）動かしたあとの、下の欄の高さの割合。
 * results と diagram はドラッグを始めたときの高さ、main は右側の欄の高さ（割合の元）。
 * 図と下の欄の高さの合計は変えず、どちらも最小の高さより低くしない
 */
export function draggedResultsRatio(start: { results: number; diagram: number; main: number }, dy: number): number {
  const total = start.results + start.diagram;
  const max = Math.max(MIN_RESULTS_HEIGHT, total - MIN_DIAGRAM_HEIGHT);
  const results = Math.min(max, Math.max(MIN_RESULTS_HEIGHT, start.results - dy));
  return results / start.main;
}

/** 右側いっぱいに広げている欄。図（diagram）か下の欄（results）。undefined は上下に分けた形 */
export type ExpandedPane = "diagram" | "results" | undefined;

/** 覚えておいた広げている欄を読む。読めない値なら、上下に分けた形 */
export function parseExpandedPane(text: string | null): ExpandedPane {
  return text === "diagram" || text === "results" ? text : undefined;
}
