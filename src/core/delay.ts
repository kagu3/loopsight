// 遅れの印（‖）。リンクとフローに付けて、図の線の途中に二重線を描く（SD の図のふつうの書き方）。
// 印は見た目だけで、シミュレーションには影響しない。実際の遅れは式（Delay や Smooth など）で表す。
// ModelJSON には遅れの印の決まった書き方がないので、Loopsight 独自の項目として display.delay（true）に持たせる。
// エンジン（simulation）は display の知らない項目をエラーにするので、実行の前に外す（modeljson.ts の engineModel）。
import { equationsOf, findElement, nameKey, referencesIn, sameName, type ModelElement, type ModelJSON } from "./modeljson.js";

/** 遅れの印を付けられる要素の種類 */
export const DELAY_MARK_TYPES = ["LINK", "FLOW"] as const;

/** 遅れの印が付いているか */
export function hasDelayMark(el: ModelElement | undefined): boolean {
  return el?.display?.delay === true;
}

/**
 * 時間をまたぐ関数（Insight Maker の関数）。1 つ目の引数は、過去の値を使う（遅れて効く）。
 * 名前は大文字と小文字を区別しない
 */
export const TIME_FUNCTIONS: ReadonlySet<string> = new Set(
  ["Delay", "Delay1", "Delay3", "DelayN", "Smooth", "SmoothN", "Trend", "Forecast", "Fix", "PastValues", "PastMax", "PastMin", "PastMedian", "PastMean", "PastStdDev", "PastCorrelation"].map(
    (f) => f.toLowerCase(),
  ),
);

/**
 * 式の中で、時間をまたぐ関数の 1 つ目の引数に入っている参照（重複なし、名前の表記は式のまま）。
 * 「Delay([発注], 3)」なら「発注」。文字列とコメントの中は見ない
 */
export function delayedReferences(equation: string): string[] {
  const out = new Map<string, string>();
  // 文字列とコメントを空白に置き換えてから探す（[名前] の中の括弧やカンマは名前の一部なので、あとで飛ばす）
  const text = equation.replace(/"[^"]*"|'[^']*'|\/\*[\s\S]*?\*\/|(#|\/\/)[^\n]*/g, (m) => " ".repeat(m.length));
  // 関数の名前は [名前] の外だけで探す（名前の中の「Delay(」などに当たらないよう、括弧の中を空白にしたもので探す。位置は text と同じ）
  const outside = text.replace(/\[[^[\]\n]*\]/g, (m) => `[${" ".repeat(m.length - 2)}]`);
  for (const m of outside.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!TIME_FUNCTIONS.has(m[1]!.toLowerCase())) continue;
    // 1 つ目の引数の終わり（同じ深さのカンマか、閉じ括弧）を探す
    let depth = 0;
    let end = text.length;
    for (let i = m.index! + m[0].length; i < text.length; i++) {
      const c = text[i]!;
      if (c === "[") {
        const close = text.indexOf("]", i + 1);
        if (close < 0) break;
        i = close;
      } else if (c === "(" || c === "{") depth++;
      else if (c === ")" || c === "}") {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        end = i;
        break;
      }
    }
    for (const ref of referencesIn(text.slice(m.index! + m[0].length, end))) {
      if (!out.has(nameKey(ref))) out.set(nameKey(ref), ref);
    }
  }
  // [発注].Delay(3) のように、参照のあとに関数を付ける書き方
  for (const m of text.matchAll(/\[([^[\]\n]+)\]\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const ref = m[1]!.trim();
    if (TIME_FUNCTIONS.has(m[2]!.toLowerCase()) && !out.has(nameKey(ref))) out.set(nameKey(ref), ref);
  }
  return [...out.values()];
}

/**
 * 遅れの印の確認：先の要素の式が、元の要素を Delay や Smooth などの時間をまたぐ関数に渡しているのに、印のないリンク。
 * 印は自動では付けない（付けるかどうかは、図で何を伝えたいかによるため）。
 * 逆（印があるのに式に時間をまたぐ関数がない）は確かめない。ストックを通る遅れ（発注してから届くまでの品物の滞留など）は、
 * 式に関数がなくても印を付けるのがふつうなため
 */
export function unmarkedDelays(model: ModelJSON): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const el of model.elements) {
    if (el.type !== "LINK" || !el.from || !el.to || hasDelayMark(el)) continue;
    const target = findElement(model, el.to);
    if (!target) continue;
    const delayed = equationsOf(target).some((eq) => delayedReferences(eq.text).some((r) => sameName(r, el.from)));
    if (delayed) out.push({ from: el.from, to: el.to });
  }
  return out;
}

/** 遅れの印の 2 本の線の間隔の半分と、線の長さの半分（図の px） */
export const DELAY_MARK_GAP = 3;
export const DELAY_MARK_HALF = 8;

/**
 * 遅れの印（‖）を描く SVG の path。at を中心に、線の向き（dir）に直交する短い線を 2 本、少しあけて並べる。
 * ビューアの図（Diagram.tsx）で使う
 */
export function delayMarkPath(at: [number, number], dir: [number, number], half = DELAY_MARK_HALF, gap = DELAY_MARK_GAP): string {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const [tx, ty] = [dir[0] / len, dir[1] / len];
  // 線に直交する向き
  const [nx, ny] = [-ty, tx];
  const r = (v: number) => Math.round(v * 10) / 10;
  return [-gap, gap]
    .map((g) => {
      const cx = at[0] + tx * g;
      const cy = at[1] + ty * g;
      return `M${r(cx - nx * half)},${r(cy - ny * half)} L${r(cx + nx * half)},${r(cy + ny * half)}`;
    })
    .join(" ");
}
