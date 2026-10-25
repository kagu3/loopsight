// 左の欄の「ループ」に並べるもの。中核の findLoops をそのまま使い、AI の find_loops と同じループを同じ順・同じ名前で出す。
// React に依存しない（テストから直接使う）
import { findLoops, MAX_LOOPS, type FeedbackLoop, type LoopKind, type LoopView } from "../../src/core/loops.js";
import { nameKey, type ModelJSON } from "../../src/core/modeljson.js";

export interface LoopItem {
  /** R1、B2、?1 など（find_loops の name と同じ） */
  name: string;
  kind: LoopKind;
  /** ループを作る要素名（find_loops の elements と同じ並び） */
  elements: string[];
  /** 遅れの印のあるつながりを通るか（find_loops の delays があるか） */
  delay: boolean;
  /** 選んだループを覚えておく鍵。極性が変わって名前（R1 → B1 など）が変わっても、同じ要素を同じ順に回るループなら同じ */
  key: string;
  /** 図で目立たせるときに渡すもの（view_diagram・export_diagram の loop に find_loops の name を渡したときと同じ） */
  view: LoopView;
}

export interface LoopList {
  loops: LoopItem[];
  /** 探すのを途中でやめたとき、その理由（find_loops の truncated と同じ） */
  truncated: false | "loops" | "steps";
}

/**
 * 要素名の並びの鍵。どこから回り始めても同じになるよう、名前（小文字）の並びがいちばん小さくなる回し方にそろえる
 */
export function loopKey(elements: string[]): string {
  const keys = elements.map(nameKey);
  let best: string[] | undefined;
  for (let i = 0; i < keys.length; i++) {
    const rotated = [...keys.slice(i), ...keys.slice(0, i)];
    if (!best || rotated.join("\n") < best.join("\n")) best = rotated;
  }
  return (best ?? []).join("\n");
}

const itemOf = (l: FeedbackLoop): LoopItem => ({
  name: l.name,
  kind: l.kind,
  elements: l.elements,
  delay: l.steps.some((s) => s.delay),
  key: loopKey(l.elements),
  view: { name: l.name, kind: l.kind, elements: l.elements },
});

/** モデルのフィードバックループの一覧（find_loops を絞り込まずに呼んだときと同じ） */
export function listLoops(model: ModelJSON): LoopList {
  const { loops, truncated } = findLoops(model);
  return { loops: loops.map(itemOf), truncated };
}

/** 種類ごとの数（find_loops の count と同じ） */
export function countLoops(loops: LoopItem[]): Record<LoopKind, number> {
  const count: Record<LoopKind, number> = { R: 0, B: 0, unknown: 0 };
  for (const l of loops) count[l.kind]++;
  return count;
}

/** 探すのを途中でやめたときの知らせ。やめていなければ undefined */
export function truncatedText(truncated: LoopList["truncated"]): string | undefined {
  if (!truncated) return undefined;
  return truncated === "loops"
    ? `ループが多いため、短いものから ${MAX_LOOPS} 個だけを出しています。`
    : "つながりが多く、探すのに時間がかかるため、途中で探すのをやめました。短いものから出しています。";
}
