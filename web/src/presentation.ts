// 発表モードの、React に依存しない計算。
import type { Equation, ModelJSON, ScenarioRunResult, Slide } from "../../src/viewer/api.js";

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

/** 「何もしない場合」と比べた変化（+12% / −39%）。比べられなければ空文字 */
export function changeFrom(base: number | null, value: number | null): string {
  if (base === null || value === null || base === 0) return "";
  const p = ((value - base) / Math.abs(base)) * 100;
  const r = Math.round(p);
  if (r === 0) return "±0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
}

/** 施策で変える値と、いまのモデルの値の組（解決案のスライドに出す） */
export function scenarioChanges(model: ModelJSON, scenario: ScenarioRunResult | undefined): { name: string; before: Equation | undefined; after: Equation }[] {
  if (!scenario) return [];
  return Object.entries(scenario.values).map(([name, after]) => {
    const el = model.elements.find((e) => e.name && e.name.toLowerCase() === name.toLowerCase());
    const b = el?.behavior;
    const before = el?.type === "STOCK" ? b?.initial_value : b?.value;
    return { name, before, after };
  });
}
