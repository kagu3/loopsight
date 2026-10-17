// 発表モードの、React に依存しない計算。
import type { Equation, ModelJSON, ScenarioRunResult, Slide } from "../../src/viewer/api.js";

// 比較スライドの値の計算は、export_slides の slides.md と同じものを使う
export { changeFrom, valueAt } from "../../src/core/format.js";

/** スライドの種類の呼び名（サーバーの SLIDE_KIND_LABEL と同じ。画面にエンジンを積まないよう、ここに持つ） */
export const KIND_LABEL: Record<Slide["kind"], string> = { problem: "問題", cause: "原因", solution: "解決案", compare: "比較", conclusion: "結論" };

/** アドレスの slide=（1 から）を、スライドの番号（0 から）にする。範囲の外は端にそろえる */
export function slideIndexFrom(search: string, count: number): number {
  const n = Number(new URLSearchParams(search).get("slide"));
  if (!Number.isInteger(n) || n < 1) return 0;
  return Math.max(0, Math.min(n, count) - 1);
}

/** アドレスに print=1 があれば、すべてのスライドを並べた印刷の形にする */
export function isPrintFrom(search: string): boolean {
  return new URLSearchParams(search).get("print") === "1";
}

/**
 * アドレスに figure=1 があれば、slide= のスライドのグラフや図だけを描く（見出しや言いたいことは描かない）。
 * MCP の export_slides が、自分の資料に貼れる画像（images/）にする
 */
export function isFigureFrom(search: string): boolean {
  return new URLSearchParams(search).get("figure") === "1";
}

/** グラフや図だけを描くときの枠の形（CSS のクラス）。グラフの数に合わせて縦横の比を変える */
export function figureShape(slide: Slide): string {
  if (slide.kind === "problem" || slide.kind === "compare") return `figure-${slide.kind} n${Math.min(slide.elements.length, 4)}`;
  return `figure-${slide.kind}`;
}

/** 押したキーで、次に出すスライドの番号。関係ないキーなら undefined */
export function nextSlide(key: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined;
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
      return Math.min(index + 1, last);
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return undefined;
  }
}

/** シナリオで変える値と、いまのモデルの値の組（解決案のスライドに出す） */
export function scenarioChanges(model: ModelJSON, scenario: ScenarioRunResult | undefined): { name: string; before: Equation | undefined; after: Equation }[] {
  if (!scenario) return [];
  return Object.entries(scenario.values).map(([name, after]) => {
    const el = model.elements.find((e) => e.name && e.name.toLowerCase() === name.toLowerCase());
    const b = el?.behavior;
    const before = el?.type === "STOCK" ? b?.initial_value : b?.value;
    return { name, before, after };
  });
}
