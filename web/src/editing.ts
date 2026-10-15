// 要素の編集フォームの中身と、送る変更の組み立て。React に依存しない（テストから直接使う）
import type { ElementPatch, ModelElement } from "../../src/viewer/api.js";

/** 数字だけなら数値、それ以外は式の文字列 */
export function parseEquation(text: string): string | number {
  const t = text.trim();
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) ? Number(t) : t;
}

/** コンバーターの表。1 行に「入力, 出力」 */
export function parseTable(text: string): [number, number][] {
  const rows: [number, number][] = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parts = line.split(/[,\t]/).map((x) => x.trim());
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`表の ${i + 1} 行目「${line}」が読めません。「入力, 出力」の形で書いてください。`);
    }
    rows.push([x, y]);
  }
  if (!rows.length) throw new Error("表が空です。");
  return rows;
}

export const tableText = (data: unknown) => (Array.isArray(data) ? (data as [number, number][]).map(([x, y]) => `${x}, ${y}`).join("\n") : "");

export interface Form {
  equation: string;
  table: string;
  units: string;
  nonNegative: boolean;
  description: string;
}

export function formOf(el: ModelElement): Form {
  const b = el.behavior ?? {};
  const eq = el.type === "STOCK" ? b.initial_value : b.value;
  return {
    equation: eq === undefined ? "" : String(eq),
    table: tableText(b.data),
    units: b.units ? String(b.units) : "",
    nonNegative: !!b.non_negative,
    description: el.description ?? "",
  };
}

/** フォームと元の要素を比べて、変えた項目だけの変更にする */
export function patchOf(el: ModelElement, before: Form, after: Form): ElementPatch | undefined {
  const behavior: Record<string, unknown> = {};
  const patch: ElementPatch = { name: el.name! };
  if (el.type !== "CONVERTER" && after.equation.trim() !== before.equation.trim()) {
    if (!after.equation.trim()) throw new Error(el.type === "STOCK" ? "初期値が空です。" : "式が空です。");
    behavior[el.type === "STOCK" ? "initial_value" : "value"] = parseEquation(after.equation);
  }
  if (el.type === "CONVERTER" && after.table.trim() !== before.table.trim()) behavior.data = parseTable(after.table);
  if (after.units.trim() !== before.units.trim()) behavior.units = after.units.trim() || null;
  if ((el.type === "STOCK" || el.type === "FLOW") && after.nonNegative !== before.nonNegative) behavior.non_negative = after.nonNegative || null;
  if (Object.keys(behavior).length) patch.behavior = behavior;
  if (after.description.trim() !== before.description.trim()) patch.description = after.description.trim() || null;
  return Object.keys(patch).length > 1 ? patch : undefined;
}
