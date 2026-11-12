// 左の欄の「ループ」に並べるもの。中核の findLoops をそのまま使い、AI の find_loops と同じループを同じ順・同じ名前・同じ記号で出す。
// React に依存しない（テストから直接使う）
import { findLoops, loopKey, MAX_LOOPS, missingLoops, type FeedbackLoop, type LoopKind, type LoopView } from "../../src/core/loops.js";
import type { ModelJSON } from "../../src/core/modeljson.js";

export { loopKey };

export interface LoopItem {
  /** R1、B2、?1 など（find_loops の symbol と同じ） */
  symbol: string;
  /** モデルの loops で付けた名前（find_loops の name と同じ。なければ undefined） */
  name?: string;
  kind: LoopKind;
  /** ループを作る要素名（find_loops の elements と同じ並び） */
  elements: string[];
  /** 遅れの印のあるつながりを通るか（find_loops の delays があるか） */
  delay: boolean;
  /** 選んだループを覚えておく鍵。極性が変わって記号（R1 → B1 など）が変わっても、同じ要素を同じ順に回るループなら同じ */
  key: string;
  /** 図で目立たせるときに渡すもの。名前があれば名前を大きく出して記号を添え、なければ記号を出す */
  view: LoopView;
}

export interface LoopList {
  /** 名前の付いたループが先（付けた順）、そのあとに名前のないループ（find_loops と同じ並び） */
  loops: LoopItem[];
  /** 探すのを途中でやめたとき、その理由（find_loops の truncated と同じ） */
  truncated: false | "loops" | "steps";
  /** 名前を付けたが、モデルが変わってなくなったループの名前（validate_model の「モデルにありません」の警告と同じもの）。画面からも外せるように出す */
  missing: string[];
}

const itemOf = (l: FeedbackLoop): LoopItem => ({
  symbol: l.symbol,
  ...(l.name !== undefined ? { name: l.name } : {}),
  kind: l.kind,
  elements: l.elements,
  delay: l.steps.some((s) => s.delay),
  key: loopKey(l.elements),
  view: l.name !== undefined ? { name: l.name, symbol: l.symbol, kind: l.kind, elements: l.elements } : { name: l.symbol, kind: l.kind, elements: l.elements },
});

/** モデルのフィードバックループの一覧（find_loops を絞り込まずに呼んだときと同じ） */
export function listLoops(model: ModelJSON): LoopList {
  const { loops, truncated } = findLoops(model);
  return { loops: loops.map(itemOf), truncated, missing: missingLoops(model) };
}

/**
 * 一覧の分け方。名前の付いたループが 1 つでもあれば、名前のないループは「ほかの n 個」の下にたたむ（others）。
 * 1 つもなければ、全部をそのまま出す（others は空）
 */
export function splitLoops(loops: LoopItem[]): { shown: LoopItem[]; others: LoopItem[] } {
  if (!loops.some((l) => l.name !== undefined)) return { shown: loops, others: [] };
  return { shown: loops.filter((l) => l.name !== undefined), others: loops.filter((l) => l.name === undefined) };
}

/** 一覧に出す経路。最後の、始まりと同じ要素は省く（例：「使っている人 → 使い始める人」） */
export const loopPath = (elements: string[]) => elements.join(" → ");

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
