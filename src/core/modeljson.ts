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
 * 図のグループ（ループサイト独自。モデルに保存し、シミュレーションには使わない）。
 * 属する要素を図で薄い色の長方形で囲み、凡例に出す。色は決まった一覧（groups.ts の GROUP_COLORS）から選ぶ
 */
export interface ElementGroup {
  name: string;
  color: string;
  elements: string[];
}

/**
 * 名前を付けたフィードバックループ（ループサイト独自。モデルに保存し、シミュレーションには使わない）。
 * ループは通る要素の並びで見分ける（どこから回り始めても同じ。loops.ts の loopKey）。R / B は持たず、いつも極性から求める
 */
export interface NamedLoop {
  /** ループの名前（「口コミ」など）。大文字と小文字を区別せず、重ねない */
  name: string;
  /** ループが通る要素の名前を、つながる順に（find_loops の elements と同じ） */
  elements: string[];
}

/**
 * 図の注釈（どこにもつながらない、文字だけのもの）。シミュレーションの要素ではないので elements に入れず、
 * ループサイト独自の項目としてモデルの annotations に保存する（エンジンの loadModelJSON は知らない項目としてエラーにする）
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

/**
 * 何も変えない実行（シナリオと並べて比べる基準）の名前と説明（ループサイト独自。モデルに保存し、シミュレーションには使わない）。
 * 何を表す線かはモデルごとに違う（「営業は今のまま」など）ので、モデルごとに付けられる。名前がなければ DEFAULT_BASELINE_NAME
 */
export interface Baseline {
  name?: string;
  description?: string;
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
  loops?: NamedLoop[];
  annotations?: Annotation[];
  baseline?: Baseline;
  engine_settings?: { units?: { name: string; base?: string; factor?: number }[]; globals?: string };
  [key: string]: unknown;
}

export function isConnector(type: ElementType): boolean {
  return type === "FLOW" || type === "LINK";
}

// ループサイトが ModelJSON に足した項目。シミュレーションのエンジン（simulation の loadModelJSON）は知らない項目をエラーにするので、
// 実行するときは engineModel で取り除いてから渡す。
// 項目を足したら、docs/reference/model-format.md の「loopsight が足した項目」の表にも書く（書き忘れると tests/docs-model-format.test.ts が落ちる）

/** 並びの項目なら 1 件ごとの型、オブジェクトの項目ならその型 */
type ItemOf<K extends keyof ModelJSON> = NonNullable<ModelJSON[K]> extends readonly (infer T)[] ? T : NonNullable<ModelJSON[K]>;

/** 型に名前を書いた項目（[key: string] のような、どんな名前でもよい項目は除く） */
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

/** ModelJSON の公式の最上位の項目 */
const MODELJSON_TOP_KEYS = ["engine", "name", "description", "file_notes", "simulation", "elements", "visualizations", "scenarios", "engine_settings"] as const satisfies readonly (keyof ModelJSON)[];

/** ModelJSON の型にある最上位の項目のうち、公式でないもの（ループサイト独自の項目） */
type LoopsightModelKey = Exclude<KnownKeys<ModelJSON>, (typeof MODELJSON_TOP_KEYS)[number]>;

/**
 * ループサイト独自の最上位の項目と、その 1 件ごとの項目。
 * ModelJSON の型にある公式でない最上位の項目、それぞれの型（ElementGroup、NamedLoop、Annotation、Baseline）の項目と、過不足がないことを型で確かめる
 * - groups：図のグループ（groups.ts）
 * - loops：ループの名前（loops.ts の setLoops）
 * - annotations：図の注釈（annotationsOf、edit.ts の setAnnotations）
 * - baseline：何も変えない実行の名前と説明（baselineOf、edit.ts の setScenarios）。並びではなく 1 つのオブジェクト
 */
const LOOPSIGHT_MODEL_ITEMS = {
  groups: { name: true, color: true, elements: true },
  loops: { name: true, elements: true },
  annotations: { id: true, text: true, coordinates: true, width: true },
  baseline: { name: true, description: true },
} as const satisfies { [K in LoopsightModelKey]: Record<keyof ItemOf<K>, true> };

/** ループサイト独自の最上位の項目 */
export const LOOPSIGHT_MODEL_KEYS = Object.keys(LOOPSIGHT_MODEL_ITEMS) as readonly (keyof typeof LOOPSIGHT_MODEL_ITEMS)[];

/** ループサイト独自の最上位の項目のうち、並びではなく 1 つのオブジェクトのもの（場所の書き方が baseline.name になる） */
const LOOPSIGHT_OBJECT_KEYS: readonly string[] = ["baseline"];

/**
 * ループサイト独自の display の項目
 * - emphasis：図で強調して大きく描く。箱になる要素に付ける（isEmphasized）
 * - delay：遅れの印（‖）。リンクとフローに付ける（delay.ts）
 */
export const LOOPSIGHT_DISPLAY_KEYS: readonly string[] = ["emphasis", "delay"];

/**
 * ループサイトが足した項目の場所の一覧（docs/reference/model-format.md の表と突き合わせる）。
 * 書き方は、最上位が groups、その 1 件ごとの項目が groups[].name、オブジェクトの項目が baseline.name、要素の display の項目が elements[].display.emphasis
 */
export const LOOPSIGHT_FIELDS: readonly string[] = [
  ...LOOPSIGHT_MODEL_KEYS.flatMap((k) => [k, ...Object.keys(LOOPSIGHT_MODEL_ITEMS[k]).map((f) => (LOOPSIGHT_OBJECT_KEYS.includes(k) ? `${k}.${f}` : `${k}[].${f}`))]),
  ...LOOPSIGHT_DISPLAY_KEYS.map((k) => `elements[].display.${k}`),
];

/**
 * ループサイトが読み書きする、ModelJSON の公式の項目の場所（書き方は LOOPSIGHT_FIELDS と同じ）。
 * 上の型（ModelJSON、ModelElement など）にある項目。docs/reference/model-format.md の「使う公式の項目」の表と突き合わせる
 */
export const MODELJSON_FIELDS: readonly string[] = [
  "engine",
  "name",
  "description",
  "file_notes",
  ...(["algorithm", "time_start", "time_length", "time_step", "time_units"] satisfies (keyof SimulationSettings)[]).map((k) => `simulation.${k}`),
  ...["type", "name", "description", "from", "to"].map((k) => `elements[].${k}`),
  ...["initial_value", "value", "non_negative", "units", "input", "input_element", "interpolation", "data", "polarity"].map((k) => `elements[].behavior.${k}`),
  ...["coordinates", "size", "from_coordinates", "to_coordinates", "interactive", "interactive_min", "interactive_max", "symbol"].map((k) => `elements[].display.${k}`),
  ...(["type", "name", "elements"] satisfies (keyof Visualization)[]).map((k) => `visualizations[].${k}`),
  ...(["name", "description", "values"] satisfies (keyof Scenario)[]).map((k) => `scenarios[].${k}`),
  "engine_settings.units",
  "engine_settings.globals",
];

/**
 * エンジンに渡すモデル。ループサイト独自の display の項目と、最上位の項目（図のグループ groups・ループの名前 loops・図の注釈 annotations・何も変えない実行の名前 baseline）を取り除いたコピー（なければそのまま返す）
 */
export function engineModel(model: ModelJSON): ModelJSON {
  const has = (el: ModelElement) => !!el.display && LOOPSIGHT_DISPLAY_KEYS.some((k) => k in el.display!);
  const hasTop = LOOPSIGHT_MODEL_KEYS.some((k) => k in model);
  const rest: ModelJSON = hasTop ? { ...model } : model;
  if (hasTop) for (const k of LOOPSIGHT_MODEL_KEYS) delete rest[k];
  if (!model.elements.some(has)) return rest;
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

/** 何も変えない実行の名前を付けていないモデルで使う名前 */
export const DEFAULT_BASELINE_NAME = "いまのまま";

/**
 * 何も変えない実行の名前と説明。名前を付けていなければ DEFAULT_BASELINE_NAME。説明がなければ description は付けない。
 * 手で書き換えて形の合わないもの（文字でない名前など）は、付けていないものとして扱う
 */
export function baselineOf(model: ModelJSON): { name: string; description?: string } {
  const b = model.baseline && typeof model.baseline === "object" ? model.baseline : {};
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : DEFAULT_BASELINE_NAME;
  const description = typeof b.description === "string" && b.description.trim() ? b.description : undefined;
  return description ? { name, description } : { name };
}

/**
 * 何も変えない実行と同じ名前のシナリオがあれば、その名前を返す。
 * 新しく付ける名前はぶつからないよう断るが、前からあるシナリオ（既定の名前を変える前に付けたものや、手で書き換えたもの）はぶつかることがある
 */
export function scenarioNamedLikeBaseline(model: ModelJSON): string | undefined {
  const baseline = baselineOf(model).name;
  return (model.scenarios ?? []).map((s, i) => s.name ?? `scenario ${i + 1}`).find((n) => sameName(n, baseline));
}

/** 何も変えない実行と同じ名前のシナリオがあるときの知らせ（set_scenarios の notes と、検証の警告） */
export function baselineClashMessage(scenario: string): string {
  return `シナリオ "${scenario}" は、何も変えない実行と同じ名前です。グラフや表で見分けられるよう、シナリオの名前を変えてください（set_scenarios の rename_to か、ビューアの表の見出し）。`;
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
