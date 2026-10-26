// 図のグループ。「お店側の要素」「お客側の要素」のような意味のまとまりを、図で薄い色の長方形で囲み、凡例に出す。
// ModelJSON には決まった書き方がないので、ループサイト独自の項目（groups）としてモデルに保存する。
// シミュレーションには使わない（エンジンの loadModelJSON は知らない項目としてエラーにするので、実行の前に外す。modeljson.ts の engineModel）。
//
// - グループは名前、色、属する要素を持つ。1 つの要素が属するグループは 1 つまで
// - 色は決まった一覧（GROUP_COLORS）から選ぶ。ループの R（赤）・B（青）と紛れないよう、赤と青は入れない
// - 囲みの位置と大きさは、属する要素の位置から決める（groupAreas）。要素を動かすと囲みも付いてくる
import type { GraphNode } from "./diagram.js";
import { textWidth, type Rect } from "./geometry.js";
import { didYouMean, findElement, nameKey, sameName, type ElementGroup, type ModelJSON } from "./modeljson.js";
import { EditError } from "./edit.js";

/** グループの色。画面ではそれぞれ、明るい表示・暗い表示のどちらでも読める薄い背景の色にする（styles.css の --group-*） */
export const GROUP_COLORS = ["yellow", "green", "teal", "purple", "pink", "brown", "gray"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const GROUP_COLOR_LABEL: Record<GroupColor, string> = {
  yellow: "黄",
  green: "緑",
  teal: "青緑",
  purple: "紫",
  pink: "桃",
  brown: "茶",
  gray: "灰",
};

export const isGroupColor = (c: unknown): c is GroupColor => typeof c === "string" && (GROUP_COLORS as readonly string[]).includes(c);

/** set_groups の 1 件分 */
export interface GroupPatch {
  name: string;
  /** 既存のグループの名前を変える */
  rename_to?: string;
  /** GROUP_COLORS のどれか。新しいグループで省略すると、ほかのグループが使っていない色 */
  color?: string;
  /** 属する要素をこの並びに置き換える */
  elements?: string[];
  /** 属する要素に足す（ほかのグループに属していれば、そちらから移す） */
  add_elements?: string[];
  /** 属する要素から外す */
  remove_elements?: string[];
}

export interface GroupReport {
  added: string[];
  updated: string[];
  removed: string[];
  notes: string[];
}

/** グループに入れられる要素（図に箱か弁があるもの。リンクは入れない） */
function memberOf(model: ModelJSON, name: string, group: string): string {
  const el = findElement(model, name);
  if (!el?.name) {
    const names = model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
    throw new EditError(`グループ "${group}" の要素 "${name}" が見つかりません。${didYouMean(name, names)}`);
  }
  return el.name;
}

function checkGroupName(name: string, groups: ElementGroup[], self?: ElementGroup): string {
  const n = name.trim();
  if (!n) throw new EditError("グループには name が必要です。");
  if (groups.some((g) => g !== self && sameName(g.name, n))) throw new EditError(`"${n}" という名前のグループがすでにあります。`);
  return n;
}

function checkColor(color: string, group: string): GroupColor {
  if (!isGroupColor(color)) throw new EditError(`グループ "${group}" の色 "${color}" は使えません。色は ${GROUP_COLORS.join("、")} のどれかにしてください。`);
  return color;
}

/** ほかのグループが使っていない色（すべて使っていれば、使っている数がいちばん少ない色） */
export function nextGroupColor(groups: Pick<ElementGroup, "color">[]): GroupColor {
  const used = (c: GroupColor) => groups.filter((g) => g.color === c).length;
  return GROUP_COLORS.reduce((best, c) => (used(c) < used(best) ? c : best), GROUP_COLORS[0]);
}

/** 新しいグループの名前の候補（「グループ 1」「グループ 2」…のうち、まだないもの） */
export function nextGroupName(groups: Pick<ElementGroup, "name">[]): string {
  for (let i = 1; ; i++) {
    const name = `グループ ${i}`;
    if (!groups.some((g) => sameName(g.name, name))) return name;
  }
}

/**
 * モデルの groups のうち、形の合うもの（名前が文字のグループ）。要素は文字のものだけにしたコピーを返す。
 * 手で書き換えたファイルの groups が並びでなかったり、中に null があったりしても、要素の名前変更や削除、要約が止まらないように
 */
export function wellFormedGroups(model: ModelJSON): ElementGroup[] {
  if (!Array.isArray(model.groups)) return [];
  return model.groups
    .filter((g): g is ElementGroup => !!g && typeof g === "object" && typeof g.name === "string" && !!g.name.trim())
    .map((g) => ({ ...g, elements: Array.isArray(g.elements) ? g.elements.filter((e): e is string => typeof e === "string") : [] }));
}

/** 要素が属するグループ（なければ undefined） */
export function groupOf(model: ModelJSON, element: string): ElementGroup | undefined {
  return wellFormedGroups(model).find((g) => g.elements.some((e) => sameName(e, element)));
}

/**
 * グループをまとめて追加・更新・削除する。モデルはその場で書き換える。
 * 名前で既存のグループを探し、あれば重ね、なければ追加する。replace なら今のグループを捨ててから足す。
 * 要素の名前は要素の表記にそろえる（ない要素はエラー）。1 つの要素が属するグループは 1 つまでなので、
 * ほかのグループに属する要素を足すと、そちらから移す。
 */
export function setGroups(model: ModelJSON, patches: GroupPatch[], options: { remove?: string[]; replace?: boolean } = {}): GroupReport {
  const report: GroupReport = { added: [], updated: [], removed: [], notes: [] };
  // 形の合わないグループ（手で書き換えたものなど）は、保存し直すときに捨てる
  const groups = options.replace ? [] : wellFormedGroups(model);
  if (options.replace) report.removed.push(...wellFormedGroups(model).map((g) => g.name));

  const find = (name: string) => groups.find((g) => sameName(g.name, name));
  for (const name of options.remove ?? []) {
    const g = find(name);
    if (!g) throw new EditError(`消すグループ "${name}" が見つかりません。${didYouMean(name, groups.map((x) => x.name))}`);
    report.removed.push(g.name);
    groups.splice(groups.indexOf(g), 1);
  }

  for (const p of patches) {
    if (!p.name?.trim()) throw new EditError("グループには name が必要です。");
    let g = find(p.name);
    if (g) {
      if (p.rename_to !== undefined) {
        const before = g.name;
        g.name = checkGroupName(p.rename_to, groups, g);
        if (!sameName(before, g.name)) report.notes.push(`グループ "${before}" を "${g.name}" に名前変更しました。`);
      }
      if (p.color !== undefined) g.color = checkColor(p.color, g.name);
      report.updated.push(g.name);
    } else {
      if (p.rename_to !== undefined) throw new EditError(`名前を変えるグループ "${p.name}" が見つかりません。${didYouMean(p.name, groups.map((x) => x.name))}`);
      const name = checkGroupName(p.name, groups);
      g = { name, color: p.color !== undefined ? checkColor(p.color, name) : nextGroupColor(groups), elements: [] };
      groups.push(g);
      report.added.push(name);
    }
    const self = g;
    const has = (n: string) => self.elements.some((e) => sameName(e, n));
    const add = (n: string) => {
      if (has(n)) return;
      // 1 つの要素が属するグループは 1 つまで。ほかのグループからは外す
      for (const other of groups) {
        if (other === self || !other.elements.some((e) => sameName(e, n))) continue;
        other.elements = other.elements.filter((e) => !sameName(e, n));
        report.notes.push(`"${n}" をグループ "${other.name}" から "${self.name}" に移しました。`);
      }
      self.elements.push(n);
    };
    if (p.elements !== undefined) {
      // 置き換える。並びは渡されたとおりにする
      const names = p.elements.map((n) => memberOf(model, n, self.name));
      self.elements = [];
      for (const n of names) add(n);
    }
    for (const n of p.add_elements ?? []) add(memberOf(model, n, self.name));
    for (const n of p.remove_elements ?? []) {
      const name = memberOf(model, n, self.name);
      if (!has(name)) report.notes.push(`"${name}" はグループ "${self.name}" に属していません。`);
      self.elements = self.elements.filter((e) => !sameName(e, name));
    }
  }
  for (const g of groups) {
    if (!g.elements.length && (report.added.includes(g.name) || report.updated.includes(g.name))) {
      report.notes.push(`グループ "${g.name}" には要素がないので、図には出ません。`);
    }
  }

  if (groups.length) model.groups = groups;
  else delete model.groups;
  return report;
}

/** 要素の名前を変えたとき、グループの中の名前も変える */
export function renameInGroups(model: ModelJSON, oldName: string, newName: string): void {
  if (!Array.isArray(model.groups)) return;
  for (const g of model.groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.elements)) continue;
    g.elements = g.elements.map((e) => (typeof e === "string" && sameName(e, oldName) ? newName : e));
  }
}

/** 要素を消したとき、グループからも外す。外したことの知らせを返す */
export function removeFromGroups(model: ModelJSON, names: string[]): string[] {
  const gone = new Set(names.map(nameKey));
  const notes: string[] = [];
  if (!Array.isArray(model.groups)) return notes;
  const isGone = (e: unknown) => typeof e === "string" && gone.has(nameKey(e));
  for (const g of model.groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.elements)) continue;
    const removed = g.elements.filter(isGone);
    if (!removed.length) continue;
    g.elements = g.elements.filter((e) => !isGone(e));
    notes.push(`グループ "${g.name}" から ${removed.map((e) => `"${e}"`).join("、")} を外しました。`);
  }
  return notes;
}

/** 図に描くグループ。elements はモデルにある要素の名前だけ（ほかのグループに先に属するものは除く） */
export interface GraphGroup {
  name: string;
  color: GroupColor;
  elements: string[];
}

/** モデルのグループを図に描く形にする。手で書き換えたファイルでも描けるよう、合わないところは黙って除く（確かめるのは checkGroups） */
export function graphGroups(model: ModelJSON): GraphGroup[] {
  const taken = new Set<string>();
  const out: GraphGroup[] = [];
  const names = new Set<string>();
  for (const g of Array.isArray(model.groups) ? model.groups : []) {
    if (!g || typeof g.name !== "string" || !g.name.trim() || names.has(nameKey(g.name))) continue;
    names.add(nameKey(g.name));
    const elements: string[] = [];
    for (const e of Array.isArray(g.elements) ? g.elements : []) {
      const el = typeof e === "string" ? findElement(model, e) : undefined;
      if (!el?.name || taken.has(nameKey(el.name))) continue;
      taken.add(nameKey(el.name));
      elements.push(el.name);
    }
    out.push({ name: g.name, color: isGroupColor(g.color) ? g.color : "gray", elements });
  }
  return out;
}

/** 囲みと、属する要素の箱のあいだ */
export const GROUP_PADDING = 16;
/** 囲みの上に取る、グループの名前の場所の高さ */
export const GROUP_LABEL_HEIGHT = 20;
/** グループの名前の文字の大きさ */
const GROUP_LABEL_FONT = 12;

/** 図のグループの囲み（図の座標）。属する要素が図に 1 つもないグループは出さない */
export interface GroupArea {
  name: string;
  color: GroupColor;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 属する要素のノードの ID */
  nodes: string[];
}

/** フローの名前が描かれるおおよその範囲（弁の下か右。geometry.ts の flowLabelRect と同じ置き方） */
function valveLabelRect(n: GraphNode): Rect {
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  const w = textWidth(n.label, 12) + 4;
  const h = 16;
  return n.labelSide === "right" ? { x: cx + n.width / 2 + 6, y: cy - h / 2, w, h } : { x: cx - w / 2, y: cy + n.height / 2 + 3, w, h };
}

/**
 * グループの囲みを、属する要素のノードの位置から決める。属する要素の箱（フローは弁とその名前）をまとめて囲み、
 * まわりに GROUP_PADDING、上にグループの名前の場所を足した長方形。名前が入るよう、幅は名前の長さより狭くしない
 */
export function groupAreas(nodes: GraphNode[], groups: GraphGroup[] | undefined): GroupArea[] {
  const out: GroupArea[] = [];
  for (const g of groups ?? []) {
    const keys = new Set(g.elements.map(nameKey));
    const members = nodes.filter((n) => n.kind !== "CLOUD" && n.element && keys.has(nameKey(n.element)));
    if (!members.length) continue;
    const rects: Rect[] = members.flatMap((n) => {
      const r = { x: n.x, y: n.y, w: n.width, h: n.height };
      return n.kind === "VALVE" ? [r, valveLabelRect(n)] : [r];
    });
    const x = Math.min(...rects.map((r) => r.x)) - GROUP_PADDING;
    const y = Math.min(...rects.map((r) => r.y)) - GROUP_PADDING - GROUP_LABEL_HEIGHT;
    const right = Math.max(...rects.map((r) => r.x + r.w)) + GROUP_PADDING;
    const bottom = Math.max(...rects.map((r) => r.y + r.h)) + GROUP_PADDING;
    const width = Math.max(right - x, textWidth(g.name, GROUP_LABEL_FONT) + 2 * GROUP_PADDING);
    out.push({ name: g.name, color: g.color, x, y, width, height: bottom - y, nodes: members.map((n) => n.id) });
  }
  return out;
}

/** 2 つの長方形が重なるか */
export function areasOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** モデルの groups の、図に描くときに除かれるところ（ない要素、使えない色、2 つのグループに属する要素など） */
export function checkGroups(model: ModelJSON): string[] {
  if (model.groups === undefined) return [];
  if (!Array.isArray(model.groups)) return ["groups が並び（配列）になっていません。set_groups で作り直してください。"];
  const out: string[] = [];
  const owner = new Map<string, string>();
  const seen = new Set<string>();
  for (const g of model.groups) {
    if (!g || typeof g.name !== "string" || !g.name.trim()) {
      out.push("名前のないグループがあります（図には出ません）。");
      continue;
    }
    if (seen.has(nameKey(g.name))) out.push(`グループ "${g.name}" が 2 つあります（あとのほうは図に出ません）。`);
    seen.add(nameKey(g.name));
    if (!isGroupColor(g.color)) out.push(`グループ "${g.name}" の色 "${String(g.color)}" は使えないので、灰で描いています。色は ${GROUP_COLORS.join("、")} のどれかです。`);
    for (const e of Array.isArray(g.elements) ? g.elements : []) {
      const el = typeof e === "string" ? findElement(model, e) : undefined;
      if (!el?.name) {
        out.push(`グループ "${g.name}" の要素 "${String(e)}" がモデルにありません。`);
        continue;
      }
      const first = owner.get(nameKey(el.name));
      if (first !== undefined) out.push(`"${el.name}" がグループ "${first}" と "${g.name}" の両方に入っています（"${first}" で描いています）。`);
      else owner.set(nameKey(el.name), g.name);
    }
  }
  return out;
}
