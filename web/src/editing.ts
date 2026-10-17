// 要素の編集フォームの中身と、送る変更の組み立て（編集モードで要素を足す・リンクを引くときも）。React に依存しない（テストから直接使う）
import type { ElementPatch, ModelElement, ModelJSON } from "../../src/viewer/api.js";
import { positionPatches, shiftIntoView, type Graph, type GraphNode } from "../../src/core/diagram.js";
import { boxLayout } from "../../src/core/geometry.js";
import { canReference, equationsOf, findElement, findLink, nameKey, referencesIn, sameName } from "../../src/core/modeljson.js";

/** 式の中で、半角にしないところ。[名前] の参照（全角の［］も）と、引用符で囲んだ文字列 */
const KEEP_IN_EQUATION = /([[［][^[\]［］\n]*[\]］]|"[^"]*"|'[^']*')/;

/** 全角の ASCII（！〜～）と全角の空白を半角にする。①や㎡、カナなど、ほかの文字は変えない */
const halfWidth = (text: string) => text.replace(/[！-～　]/g, (c) => (c === "　" ? " " : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

/**
 * 全角で打った数字と記号を半角にする（「０.３」→「0.3」、「［人口］＊２」→「[人口]*2」）。
 * [名前] の中は要素名なので変えない（「人口（千人）」のような名前の参照を壊さないため）。引用符で囲んだ文字列の中も変えない
 */
export function halfWidthEquation(text: string): string {
  return text
    .split(KEEP_IN_EQUATION)
    .map((part, i) => (i % 2 === 0 ? halfWidth(part) : /^[[［]/.test(part) ? `[${part.slice(1, -1)}]` : part))
    .join("");
}

/** 数字だけなら数値、それ以外は式の文字列。全角の数字と記号は半角にする */
export function parseEquation(text: string): string | number {
  const t = halfWidthEquation(text).trim();
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
  name: string;
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
    name: el.name ?? "",
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
  // 名前を変えると、サーバーが式・シナリオ・実際のデータの列名などの参照も書き換える
  if (after.name.trim() !== before.name.trim()) {
    if (!after.name.trim()) throw new Error("名前が空です。");
    patch.rename_to = after.name.trim();
  }
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

/** 名前を変えたあとの名前。変えていなければそのまま（大文字と小文字、前後の空白は区別しない） */
export function renamedName(name: string, renamed: [string, string][]): string {
  return renamed.find(([from]) => sameName(from, name))?.[1] ?? name;
}

/** 編集モードで図に足せる要素の種類 */
export type NewElementType = "STOCK" | "FLOW" | "VARIABLE";
export const NEW_ELEMENT_LABEL: Record<NewElementType, string> = { STOCK: "ストック", FLOW: "フロー", VARIABLE: "変数" };

/** フローの両端の雲を、置いた場所から左右にどれだけ離すか（雲の中心まで） */
const FLOW_HALF = 70;
/** 図の雲の大きさ（core/diagram.ts と同じ） */
const CLOUD_SIZE = [36, 26] as const;

/** 足す要素の仮の名前。「新しいストック」、重なれば「新しいストック 2」のように番号を付ける（大文字と小文字は区別しない） */
export function newElementName(model: ModelJSON, type: NewElementType): string {
  const base = `新しい${NEW_ELEMENT_LABEL[type]}`;
  const taken = new Set(model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => nameKey(e.name!)));
  if (!taken.has(nameKey(base))) return base;
  for (let i = 2; ; i++) if (!taken.has(nameKey(`${base} ${i}`))) return `${base} ${i}`;
}

/**
 * 図の at（図の座標）を中心に要素を足す変更。値は 0 で、名前や式はあとで詳細欄の「編集」で直す。フローは両端を雲にする。
 * 図を動かしたときと同じく、座標のない要素を仮に並べているときや、左や上にはみ出すときは、見えている配置もまとめて保存する
 */
export function addElementPatches(model: ModelJSON, graph: Graph, type: NewElementType, at: { x: number; y: number }): { name: string; patches: ElementPatch[] } {
  const name = newElementName(model, type);
  const added: GraphNode[] = [];
  if (type === "FLOW") {
    const [w, h] = CLOUD_SIZE;
    for (const [end, dx] of [["from", -FLOW_HALF], ["to", FLOW_HALF]] as const) {
      added.push({ id: `new:${end}`, kind: "CLOUD", label: "", cloudOf: { flow: name, end }, x: at.x + dx - w / 2, y: at.y - h / 2, width: w, height: h, shape: "rect" });
    }
  } else {
    const [w, h] = boxLayout(type, name).size;
    added.push({ id: "new", kind: type, label: name, element: name, x: at.x - w / 2, y: at.y - h / 2, width: w, height: h, shape: "rect" });
  }
  const all = [...graph.nodes, ...added];
  const shifted = shiftIntoView(all);
  const ids = graph.missingCoordinates || shifted ? undefined : new Set(added.map((n) => n.id));
  const behavior = type === "STOCK" ? { initial_value: 0 } : { value: 0 };
  return { name, patches: [{ type, name, behavior }, ...positionPatches(shifted ?? all, ids)] };
}

/**
 * 編集モードで from から to へリンク（LINK）を引けないときの理由。引けるなら undefined。
 * 中核の upsertElements は同じ向きのリンクがあれば上書きし、自分自身へのリンクも足してしまうので、送る前に画面で確かめる
 */
export function linkProblem(model: ModelJSON, from: string, to: string): string | undefined {
  const a = findElement(model, from);
  const b = findElement(model, to);
  if (!a || !b) return `「${a ? to : from}」が見つかりません。消された可能性があります。`;
  if (a === b) return `「${a.name}」から「${a.name}」自身へは、リンクを引けません。`;
  if (findLink(model, a.name!, b.name!)) return `「${a.name}」から「${b.name}」へのリンクは、すでにあります。`;
  return undefined;
}

/**
 * 編集モードでリンクを消せないときの理由。消せるなら undefined。
 * 先の要素の式が元の要素を参照しているリンクは、消すと式がエラーになり、ほかの編集のときに自動で付け直される（upsertElements）ので消さない。
 * コンバーターの入力元からのリンクも、入力のつながりなので消さない
 */
export function linkRemoveProblem(model: ModelJSON, from: string, to: string): string | undefined {
  const target = findElement(model, to);
  if (!target) return undefined;
  if (target.type === "CONVERTER" && target.behavior?.input === "ELEMENT" && typeof target.behavior?.input_element === "string" && sameName(target.behavior.input_element, from)) {
    return `「${target.name}」の入力が「${from}」なので、このリンクは消せません。`;
  }
  // リンクを消しても参照できるなら（フローが自分の両端のストックを見ているときなど）、消せる。判断は検証（canReference）と同じ
  const without = { ...model, elements: model.elements.filter((e) => !(e.type === "LINK" && sameName(e.from, from) && sameName(e.to, to))) };
  if (canReference(without, target, from)) return undefined;
  const uses = equationsOf(target).some((eq) => referencesIn(eq.text).some((r) => sameName(r, from)));
  return uses ? `「${target.name}」の式が [${from}] を使っているので、このリンクは消せません。先に「${target.name}」の式を直してください。` : undefined;
}

/** フローの端。from は入ってくる側、to は出ていく側 */
export type FlowEnd = "from" | "to";

/**
 * 編集モードで、フローの端をつなぎ替える変更。to がストックの名前ならそのストックにつなぎ、雲の座標を消す。
 * 図の座標なら、そこに雲を置く（つながっていたストックから外す。もとから雲なら雲を動かすだけ）。
 * つなぎ替えられないときはその理由、変えることがなければ空の配列を返す。
 * 雲を置くときは、要素を足すときと同じく、座標のない要素を仮に並べているときや、左や上にはみ出すときは、見えている配置もまとめて保存する
 */
export function reconnectPatches(model: ModelJSON, graph: Graph, flow: string, end: FlowEnd, to: string | { x: number; y: number }): ElementPatch[] | string {
  const f = findElement(model, flow);
  if (!f || f.type !== "FLOW") return `フロー「${flow}」が見つかりません。消された可能性があります。`;
  const key = end === "from" ? "from_coordinates" : "to_coordinates";
  if (typeof to === "string") {
    const s = findElement(model, to);
    if (!s) return `「${to}」が見つかりません。消された可能性があります。`;
    if (s.type !== "STOCK") return `フローの端は、ストックにだけつなげます（「${s.name}」はストックではありません）。`;
    if (sameName(f[end], s.name)) return [];
    if (sameName(f[end === "from" ? "to" : "from"], s.name)) return `「${f.name}」の両端を、同じストック「${s.name}」にはつなげません。`;
    return [{ name: f.name!, [end]: s.name!, display: { [key]: null } }];
  }
  const [w, h] = CLOUD_SIZE;
  const cloud: GraphNode = { id: `cloud:${end}`, kind: "CLOUD", label: "", cloudOf: { flow: f.name!, end }, x: to.x - w / 2, y: to.y - h / 2, width: w, height: h, shape: "rect" };
  // もとの雲（あれば）の代わりに、新しい雲を置く
  const all = [...graph.nodes.filter((n) => !(n.cloudOf && sameName(n.cloudOf.flow, f.name) && n.cloudOf.end === end)), cloud];
  const shifted = shiftIntoView(all);
  const detach: ElementPatch[] = f[end] ? [{ name: f.name!, [end]: null }] : [];
  if (graph.missingCoordinates || shifted) return [...detach, ...positionPatches(shifted ?? all)];
  return [{ name: f.name!, ...(f[end] ? { [end]: null } : {}), display: { [key]: [Math.round(to.x), Math.round(to.y)] } }];
}
