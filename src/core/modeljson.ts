// ModelJSON（https://github.com/scottfr/modeljson）の型と小さな補助関数

export const ELEMENT_TYPES = ["STOCK", "FLOW", "VARIABLE", "CONVERTER", "LINK"] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/**
 * 対応していない要素の種類。ModelJSON にはあるが、エージェントベースのモデルの部品で、システムダイナミクスのモデルには使わない。
 * 含むモデルは読み込むときに断る（unsupportedElementsMessage）
 */
const UNSUPPORTED_TYPES = ["STATE", "TRANSITION"];

/** 断る文に並べる要素の数の上限 */
const MAX_UNSUPPORTED_LISTED = 10;

/** 対応していない要素（STATE、TRANSITION）があれば、どの要素かと理由を書いた文を返す。なければ undefined */
export function unsupportedElementsMessage(elements: readonly unknown[]): string | undefined {
  const found = elements.filter(
    (e): e is { type: string; name?: unknown } => !!e && typeof e === "object" && UNSUPPORTED_TYPES.includes((e as { type?: unknown }).type as string),
  );
  if (!found.length) return undefined;
  const listed = found
    .slice(0, MAX_UNSUPPORTED_LISTED)
    .map((e) => (typeof e.name === "string" && e.name.trim() ? `${e.type} "${e.name}"` : `名前のない ${e.type}`));
  const more = found.length > MAX_UNSUPPORTED_LISTED ? `ほか ${found.length - MAX_UNSUPPORTED_LISTED} 個` : "";
  return (
    `対応していない要素があります: ${[...listed, ...(more ? [more] : [])].join("、")}。` +
    "ループサイトはシステムダイナミクスのモデル（ストック、フロー、変数、コンバーター、リンク）だけを扱うため、状態（STATE）と遷移（TRANSITION）を含むモデルは読み込めません。"
  );
}

export const TIME_UNITS = ["SECONDS", "MINUTES", "HOURS", "DAYS", "WEEKS", "MONTHS", "YEARS"] as const;
export type TimeUnits = (typeof TIME_UNITS)[number];

export type Point = [number, number];
export type Equation = string | number | boolean;

export interface ElementDisplay {
  coordinates?: Point;
  size?: Point;
  from_coordinates?: Point;
  to_coordinates?: Point;
  interactive?: boolean;
  interactive_min?: number;
  interactive_max?: number;
  symbol?: string;
  /**
   * 図で強調して大きく描くか（ループサイト独自の項目。Insight Maker は使わず、シミュレーションにも影響しない）。
   * 段階は「ふつう」（項目なし）と「強調」（true）の 2 つだけ
   */
  emphasis?: boolean;
  [key: string]: unknown;
}

export interface ElementBehavior {
  initial_value?: Equation;
  value?: Equation;
  non_negative?: boolean;
  units?: string;
  input?: "TIME" | "ELEMENT";
  input_element?: string;
  interpolation?: "NONE" | "LINEAR";
  data?: Point[];
  polarity?: "NEUTRAL" | "POSITIVE" | "NEGATIVE";
  [key: string]: unknown;
}

export interface ModelElement {
  type: ElementType;
  name?: string;
  description?: string;
  from?: string | null;
  to?: string | null;
  behavior?: ElementBehavior;
  display?: ElementDisplay;
  [key: string]: unknown;
}

export interface SimulationSettings {
  algorithm?: "RK1" | "RK4";
  time_start?: number;
  time_length?: number;
  time_step?: number;
  time_units?: TimeUnits;
}

export interface Visualization {
  type?: "TIME_SERIES" | "TABLE";
  name?: string;
  elements: string[];
}

export interface Scenario {
  name?: string;
  description?: string;
  values: Record<string, Equation>;
}

/**
 * 図のグループ（ループサイト独自。scenarios と同じくモデルに保存し、シミュレーションには使わない）。
 * 属する要素を図で薄い色の長方形で囲み、凡例に出す。色は決まった一覧（groups.ts の GROUP_COLORS）から選ぶ
 */
export interface ElementGroup {
  name: string;
  color: string;
  elements: string[];
}

/**
 * 図の注釈（どこにもつながらない、文字だけのもの）。シミュレーションの要素ではないので elements に入れず、
 * scenarios と同じく、ループサイト独自の項目としてモデルの annotations に保存する（Insight Maker に読み込ませると消える）
 */
export interface Annotation {
  /** 注釈を見分ける名前（MCP の set_annotations で直す・消すときに使う） */
  id: string;
  /** 文字。改行で行を分けられる。幅（width）で折り返す */
  text: string;
  /** 左上の座標 */
  coordinates: Point;
  /** 折り返す幅（なければ ANNOTATION_WIDTH） */
  width?: number;
}

export interface ModelJSON {
  engine?: "SIMULATION_PACKAGE";
  name?: string;
  description?: string;
  file_notes?: string;
  simulation?: SimulationSettings;
  elements: ModelElement[];
  visualizations?: Visualization[];
  scenarios?: Scenario[];
  groups?: ElementGroup[];
  annotations?: Annotation[];
  engine_settings?: { units?: { name: string; base?: string; factor?: number }[]; globals?: string };
  [key: string]: unknown;
}

export function isConnector(type: ElementType): boolean {
  return type === "FLOW" || type === "LINK";
}

/**
 * ループサイト独自の display の項目。シミュレーションのエンジン（simulation の loadModelJSON）は知らない項目をエラーにするので、
 * 実行するときは engineModel で取り除いてから渡す
 * - emphasis：図で強調して大きく描く。箱になる要素に付ける（isEmphasized）
 * - delay：遅れの印（‖）。リンクとフローに付ける（delay.ts）
 */
export const LOOPSIGHT_DISPLAY_KEYS: readonly string[] = ["emphasis", "delay"];

/**
 * エンジンに渡すモデル。ループサイト独自の display の項目と、最上位の図のグループ（groups）・図の注釈（annotations）を取り除いたコピー（なければそのまま返す）
 */
export function engineModel(model: ModelJSON): ModelJSON {
  const has = (el: ModelElement) => !!el.display && LOOPSIGHT_DISPLAY_KEYS.some((k) => k in el.display!);
  const { groups: _groups, annotations: _annotations, ...rest } = model;
  if (!model.elements.some(has)) return "groups" in model || "annotations" in model ? rest : model;
  return {
    ...rest,
    elements: model.elements.map((el) => {
      if (!has(el)) return el;
      const display = Object.fromEntries(Object.entries(el.display!).filter(([k]) => !LOOPSIGHT_DISPLAY_KEYS.includes(k)));
      const { display: _display, ...rest } = el;
      return Object.keys(display).length ? { ...rest, display } : rest;
    }),
  };
}

/** 図で強調する要素か（display.emphasis） */
export function isEmphasized(el: ModelElement): boolean {
  return el.display?.emphasis === true;
}

/** モデルの注釈のうち、図に描けるもの（id、文字、座標がそろっているもの）。手で書き換えて壊れたものは飛ばす */
export function annotationsOf(model: ModelJSON): Annotation[] {
  if (!Array.isArray(model.annotations)) return [];
  return model.annotations.filter(
    (a) =>
      !!a &&
      typeof a.id === "string" &&
      typeof a.text === "string" &&
      Array.isArray(a.coordinates) &&
      a.coordinates.length === 2 &&
      a.coordinates.every((v) => typeof v === "number" && Number.isFinite(v)),
  );
}

/** 名前の比較キー。Insight Maker の名前は大文字小文字を区別しない。 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return nameKey(a) === nameKey(b);
}

/** LINK 以外の要素を名前で探す */
export function findElement(model: ModelJSON, name: string): ModelElement | undefined {
  return model.elements.find((e) => e.type !== "LINK" && sameName(e.name, name));
}

export function findLink(model: ModelJSON, from: string, to: string): ModelElement | undefined {
  return model.elements.find((e) => e.type === "LINK" && sameName(e.from, from) && sameName(e.to, to));
}

/** el の式が ref を参照してよいか（リンクがあるか、フローが自分のストックを見ているか）。検証（validate.ts）と、画面でリンクを消せるかの判断で使う */
export function canReference(model: ModelJSON, el: ModelElement, ref: string): boolean {
  if (el.name && sameName(el.name, ref)) return true;
  if (el.type === "FLOW" && (sameName(el.from, ref) || sameName(el.to, ref))) return true;
  return model.elements.some((l) => l.type === "LINK" && sameName(l.from, ref) && sameName(l.to, el.name));
}

/** 要素の式（参照を含みうる値）を返す。型ごとに入っている場所が違う。 */
export function equationsOf(el: ModelElement): { field: "initial_value" | "value"; text: string }[] {
  const out: { field: "initial_value" | "value"; text: string }[] = [];
  const b = el.behavior ?? {};
  if (el.type === "STOCK" && typeof b.initial_value === "string") out.push({ field: "initial_value", text: b.initial_value });
  if ((el.type === "VARIABLE" || el.type === "FLOW") && typeof b.value === "string") {
    out.push({ field: "value", text: b.value });
  }
  return out;
}

/** 式の中の [名前] 参照を取り出す（重複なし、出現順） */
export function referencesIn(equation: string): string[] {
  const seen = new Map<string, string>();
  for (const m of equation.matchAll(/\[([^[\]\n]+)\]/g)) {
    const name = m[1]!.trim();
    if (name && !seen.has(nameKey(name))) seen.set(nameKey(name), name);
  }
  return [...seen.values()];
}

/** 式の中の [旧名] を [新名] に置き換える */
export function renameInEquation(equation: string, oldName: string, newName: string): string {
  return equation.replace(/\[([^[\]\n]+)\]/g, (whole, inner: string) =>
    sameName(inner, oldName) ? `[${newName}]` : whole,
  );
}

function editDistance(a: string, b: string): number {
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 打ち間違いの候補：name に近い名前を近い順に返す（最大 3 件） */
export function similarNames(name: string, candidates: string[]): string[] {
  const key = nameKey(name);
  const limit = Math.max(2, Math.floor(key.length / 3));
  return candidates
    .map((c) => ({ c, k: nameKey(c), d: editDistance(key, nameKey(c)) }))
    // 短い名前どうし（"x" と "z" など）は、1 文字も合っていなければ候補にしない
    .filter((x) => x.d <= limit && x.d < Math.min(key.length, x.k.length))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.c);
}

/** 「もしかして」の文。候補がなければ空文字 */
export function didYouMean(name: string, candidates: string[]): string {
  const s = similarNames(name, candidates);
  return s.length ? `もしかして ${s.map((n) => `"${n}"`).join("、")} ですか？` : "";
}

export function emptyModel(name: string, simulation: SimulationSettings = {}): ModelJSON {
  return {
    engine: "SIMULATION_PACKAGE",
    name,
    simulation: {
      algorithm: "RK1",
      time_start: 0,
      time_length: 100,
      time_step: 1,
      time_units: "YEARS",
      ...simulation,
    },
    elements: [],
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
