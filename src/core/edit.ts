import type { ElementBehavior, ElementDisplay, ElementType, ModelElement, ModelJSON, SimulationSettings } from "./modeljson.js";
import { EDITABLE_TYPES, ELEMENT_TYPES, TIME_UNITS, didYouMean, equationsOf, findElement, findLink, nameKey, referencesIn, renameInEquation, sameName } from "./modeljson.js";
import { canReference } from "./validate.js";

export class EditError extends Error {
  override name = "EditError";
}

/** 「要素が見つかりません」のエラー。似た名前があれば添える */
function notFoundError(model: ModelJSON, what: string, name: string): EditError {
  return new EditError(`${what} "${name}" が見つかりません。${guessName(model, name)}`);
}

function guessName(model: ModelJSON, name: string): string {
  return didYouMean(name, model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!));
}

/** upsert_elements の 1 件分。behavior と display は既存の値に重ねる（null を入れるとその項目を消す）。 */
export interface ElementPatch {
  type?: ElementType;
  name?: string;
  /** 既存の要素の名前を変える。式やリンクの参照も書き換える。 */
  rename_to?: string;
  description?: string | null;
  from?: string | null;
  to?: string | null;
  behavior?: Record<string, unknown>;
  display?: Record<string, unknown>;
}

export interface EditReport {
  added: string[];
  updated: string[];
  removed: string[];
  /** 自動で追加したリンク */
  auto_links: string[];
  notes: string[];
}

function emptyReport(): EditReport {
  return { added: [], updated: [], removed: [], auto_links: [], notes: [] };
}

function describe(el: Pick<ModelElement, "type" | "name" | "from" | "to">): string {
  return el.type === "LINK" ? `LINK ${el.from ?? "?"} → ${el.to ?? "?"}` : `${el.type} "${el.name}"`;
}

function mergeObject<T extends object>(base: T | undefined, patch: Record<string, unknown> | undefined): T | undefined {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

function applyPatch(el: ModelElement, p: ElementPatch): void {
  if (p.description !== undefined) {
    if (p.description === null || p.description === "") delete el.description;
    else el.description = p.description;
  }
  if (el.type !== "STOCK" && el.type !== "VARIABLE" && el.type !== "CONVERTER" && el.type !== "STATE") {
    if (p.from !== undefined) el.from = p.from;
    if (p.to !== undefined) el.to = p.to;
  }
  const behavior = mergeObject<ElementBehavior>(el.behavior, p.behavior);
  if (behavior) el.behavior = behavior;
  else delete el.behavior;
  const display = mergeObject<ElementDisplay>(el.display, p.display);
  if (display) el.display = display;
  else delete el.display;
}

/** 要素の名前を変え、モデル内の参照もすべて書き換える */
export function renameElement(model: ModelJSON, oldName: string, newName: string): void {
  const el = findElement(model, oldName);
  if (!el) throw notFoundError(model, "要素", oldName);
  const clash = findElement(model, newName);
  if (clash && clash !== el) throw new EditError(`"${newName}" という名前の要素がすでにあります。`);
  const from = el.name!;
  el.name = newName;

  for (const other of model.elements) {
    for (const eq of equationsOf(other)) {
      other.behavior![eq.field] = renameInEquation(eq.text, from, newName);
    }
    if (sameName(other.from, from)) other.from = newName;
    if (sameName(other.to, from)) other.to = newName;
    if (other.type === "CONVERTER" && sameName(other.behavior?.input_element, from)) other.behavior!.input_element = newName;
  }
  for (const v of model.visualizations ?? []) {
    v.elements = v.elements.map((n) => (sameName(n, from) ? newName : n));
  }
  for (const s of model.scenarios ?? []) {
    for (const key of Object.keys(s.values)) {
      if (sameName(key, from)) {
        const val = s.values[key]!;
        delete s.values[key];
        s.values[newName] = val;
      }
    }
  }
}

function checkNewElement(p: ElementPatch): ElementType {
  if (!p.type) throw new EditError(`新しい要素 ${p.name ? `"${p.name}" ` : ""}には type が必要です。`);
  if (!ELEMENT_TYPES.includes(p.type)) throw new EditError(`不明な要素の種類 "${p.type}"。`);
  if (!(EDITABLE_TYPES as readonly string[]).includes(p.type)) {
    throw new EditError(`${p.type} は段階 1 では追加できません（追加できるのは ${EDITABLE_TYPES.join(", ")}）。`);
  }
  return p.type;
}

/**
 * 要素をまとめて追加・更新する。モデルはその場で書き換える。
 * LINK は from と to の組で、それ以外は名前で既存の要素を探す。
 */
export function upsertElements(model: ModelJSON, patches: ElementPatch[], options: { autoLink?: boolean } = {}): EditReport {
  const report = emptyReport();

  for (const p of patches) {
    if (p.type === "LINK" || (!p.name && p.from !== undefined && p.to !== undefined && !p.type)) {
      if (!p.from || !p.to) throw new EditError("LINK には from と to の両方が必要です。");
      const existing = findLink(model, p.from, p.to);
      if (existing) {
        applyPatch(existing, { ...p, from: undefined, to: undefined });
        report.updated.push(describe(existing));
      } else {
        const link: ModelElement = { type: "LINK", from: p.from, to: p.to };
        if (p.name) link.name = p.name;
        applyPatch(link, { ...p, from: undefined, to: undefined });
        model.elements.push(link);
        report.added.push(describe(link));
      }
      continue;
    }

    if (!p.name?.trim()) throw new EditError("LINK 以外の要素には name が必要です。");
    const existing = findElement(model, p.name);
    if (existing) {
      if (p.type && p.type !== existing.type) {
        throw new EditError(`"${existing.name}" は ${existing.type} です。種類を ${p.type} に変えるには、いったん削除してから追加してください。`);
      }
      if (p.rename_to && !sameName(p.rename_to, existing.name)) {
        const before = existing.name!;
        renameElement(model, before, p.rename_to.trim());
        report.notes.push(`"${before}" を "${existing.name}" に名前変更し、参照も書き換えました。`);
      } else if (p.rename_to) {
        existing.name = p.rename_to.trim();
      }
      applyPatch(existing, p);
      report.updated.push(describe(existing));
    } else {
      if (p.rename_to) throw notFoundError(model, "名前を変える要素", p.name);
      // 既存の要素を直すつもりで名前を打ち間違えた場合
      const guess = p.type ? "" : guessName(model, p.name);
      if (guess) throw new EditError(`要素 "${p.name}" が見つかりません。${guess}新しく追加するなら type を指定してください。`);
      const type = checkNewElement(p);
      const el: ModelElement = { type, name: p.name.trim() };
      if (type === "FLOW") {
        el.from = p.from ?? null;
        el.to = p.to ?? null;
      }
      applyPatch(el, { ...p, from: undefined, to: undefined });
      model.elements.push(el);
      report.added.push(describe(el));
    }
  }

  if (options.autoLink !== false) report.auto_links = addMissingLinks(model);
  return report;
}

/** 式が参照しているのにリンクがない組み合わせに LINK を足す */
export function addMissingLinks(model: ModelJSON): string[] {
  const added: string[] = [];
  for (const el of [...model.elements]) {
    if (!el.name) continue;
    for (const eq of equationsOf(el)) {
      for (const ref of referencesIn(eq.text)) {
        const target = findElement(model, ref);
        if (!target || canReference(model, el, ref)) continue;
        const link: ModelElement = { type: "LINK", from: target.name!, to: el.name };
        model.elements.push(link);
        added.push(describe(link));
      }
    }
  }
  return added;
}

export interface RemoveTarget {
  /** 要素の名前（LINK 以外） */
  name?: string;
  /** LINK を消すときは from と to で指定する */
  from?: string;
  to?: string;
}

/**
 * 要素を削除する。消した要素につながるリンクも消す。
 * ストックを消すと、つながっていたフローは残して端を空（モデルの外）にする。cascadeFlows なら一緒に消す。
 */
export function removeElements(model: ModelJSON, targets: RemoveTarget[], options: { cascadeFlows?: boolean } = {}): EditReport {
  const report = emptyReport();
  const removed = new Set<ModelElement>();
  const removedNames: string[] = [];

  const removeOne = (el: ModelElement) => {
    if (removed.has(el)) return;
    removed.add(el);
    report.removed.push(describe(el));
    if (el.name && el.type !== "LINK") removedNames.push(el.name);
  };

  for (const t of targets) {
    if (t.name) {
      const el = findElement(model, t.name);
      if (!el) throw notFoundError(model, "要素", t.name);
      removeOne(el);
    } else if (t.from && t.to) {
      const link = findLink(model, t.from, t.to);
      if (!link) throw new EditError(`LINK ${t.from} → ${t.to} が見つかりません。`);
      removeOne(link);
    } else {
      throw new EditError("削除する要素は name、LINK なら from と to で指定してください。");
    }
  }

  // 消した要素につながるものを片付ける（フローを消すとそのフローのリンクも消えるので繰り返す）
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of model.elements) {
      if (removed.has(el)) continue;
      const touches = removedNames.some((n) => sameName(el.from, n) || sameName(el.to, n));
      if (!touches) continue;
      if (el.type === "LINK" || (options.cascadeFlows && (el.type === "FLOW" || el.type === "TRANSITION"))) {
        removeOne(el);
        changed = true;
      }
    }
  }

  model.elements = model.elements.filter((e) => !removed.has(e));

  for (const el of model.elements) {
    for (const end of ["from", "to"] as const) {
      const n = removedNames.find((r) => sameName(el[end], r));
      if (n) {
        el[end] = null;
        report.notes.push(`${describe(el)} の ${end} は "${n}" を指していたので空（モデルの外）にしました。`);
      }
    }
    if (el.type === "CONVERTER" && removedNames.some((n) => sameName(el.behavior?.input_element, n))) {
      el.behavior!.input = "TIME";
      delete el.behavior!.input_element;
      report.notes.push(`CONVERTER "${el.name}" の入力を TIME に戻しました。`);
    }
    for (const eq of equationsOf(el)) {
      const dangling = referencesIn(eq.text).filter((r) => removedNames.some((n) => sameName(r, n)));
      if (dangling.length) {
        report.notes.push(`${describe(el)} の式がまだ ${dangling.map((d) => `[${d}]`).join(", ")} を参照しています。式を直してください。`);
      }
    }
  }

  const gone = new Set(removedNames.map(nameKey));
  for (const v of model.visualizations ?? []) v.elements = v.elements.filter((n) => !gone.has(nameKey(n)));
  if (model.visualizations) model.visualizations = model.visualizations.filter((v) => v.elements.length > 0);
  for (const s of model.scenarios ?? []) {
    for (const key of Object.keys(s.values)) if (gone.has(nameKey(key))) delete s.values[key];
  }
  return report;
}

/** シミュレーション設定を部分的に更新する */
export function setSimulation(model: ModelJSON, patch: SimulationSettings): SimulationSettings {
  const next: SimulationSettings = { ...(model.simulation ?? {}), ...stripUndefined(patch) };
  checkSimulation(next);
  model.simulation = next;
  return next;
}

export function checkSimulation(s: SimulationSettings): void {
  if (s.time_length !== undefined && !(s.time_length > 0)) throw new EditError("time_length は正の数にしてください。");
  if (s.time_step !== undefined && !(s.time_step > 0)) throw new EditError("time_step は正の数にしてください。");
  if (s.time_step !== undefined && s.time_length !== undefined && s.time_step > s.time_length) {
    throw new EditError("time_step が time_length より大きくなっています。");
  }
  if (s.algorithm !== undefined && s.algorithm !== "RK1" && s.algorithm !== "RK4") throw new EditError('algorithm は "RK1"（オイラー法）か "RK4" です。');
  if (s.time_units !== undefined && !TIME_UNITS.includes(s.time_units)) throw new EditError(`time_units は ${TIME_UNITS.join(", ")} のどれかです。`);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
