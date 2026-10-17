// 選んだ要素の式に、その時点の値を入れたもの（図の欄の「値を表示」がオンのとき、選んだ要素の横に出す）。React に依存しない。
// 上の行は式（[名前] の括弧を外す）、下の行は同じ並びで、参照しているところにその時点の値を入れたもの。左辺はその要素の値。
// ストックは式の代わりに、出入りするフローの値で「入る量 − 出る量」を出す。
// Delay や Smooth のような時間をまたぐ関数に渡す値（1 つ目の引数）は、いまの値を入れると読み違えるので、名前のまま残す。
// 式が長いときや、複数の行に分かれているときは、下の行をそろえず、参照ごとの値の一覧に切り替える。

import type { ModelElement, ModelJSON } from "../../src/viewer/api.js";
import { referencesIn } from "../../src/core/modeljson.js";
import { formatValue } from "./format.js";
import { nameKey } from "./scenarios.js";

/** 式の一片。ref は要素の参照、func は関数の名前、op は演算子、num は数（単位つきの数を含む） */
export interface FormulaToken {
  kind: "ref" | "func" | "op" | "num" | "paren" | "comma" | "other";
  /** 上の行に出す文字（参照は括弧を外した名前。演算子は × ÷ − などに置き換える） */
  text: string;
  /** 参照の、その時点の値（グラフのツールチップと同じ丸め方）。値を入れないときはなし */
  value?: string;
  /** 参照の、その時点の値（丸める前）。値を入れないときはなし */
  raw?: number;
  /** 時間をまたぐ関数に渡す参照（値を入れず、名前のまま出す） */
  held?: boolean;
}

/** 選んだ要素 1 つ分の、値を入れた式 */
export interface FormulaView {
  /** 左辺の名前（ストックは「〇〇の増え方」） */
  name: string;
  /** 左辺の値。値がないときは「—」 */
  value: string;
  /** 左辺の値（丸める前） */
  raw?: number;
  /** 右辺の式の並び。決まった値だけの変数（式が数だけ）は空 */
  tokens: FormulaToken[];
  /**
   * aligned：上の行に式、下の行に同じ並びで値を入れたもの。
   * list：上に式を出し、下に参照ごとの値の一覧（式が長い・複数の行に分かれているとき）
   */
  layout: "aligned" | "list";
  /** 参照ごとの値（重なりなし、出てくる順）。list のときに出す */
  refs: { name: string; value: string; held?: boolean }[];
  /** 添える一言（ストックに出入りするフローがないときなど） */
  note?: string;
}

/**
 * 時間をまたぐ関数（Insight Maker の関数）。1 つ目の引数は、過去の値を使うので、いまの値を入れない。
 * 名前は大文字と小文字を区別しない
 */
const TIME_FUNCTIONS = new Set(
  ["Delay", "Delay1", "Delay3", "DelayN", "Smooth", "SmoothN", "Trend", "Forecast", "Fix", "PastValues", "PastMax", "PastMin", "PastMedian", "PastMean", "PastStdDev", "PastCorrelation"].map(
    (f) => f.toLowerCase(),
  ),
);

/** 下の行をそろえて出せる、式の片の数の上限。これより長いと、横に長くなりすぎるので一覧にする */
const ALIGN_LIMIT = 24;
/**
 * 下の行をそろえて出せる幅の目安（画面の px。式の箱の幅の上限 640px から余白を引いたもの）。
 * 名前の長い参照が多いと、片の数が少なくても箱からはみ出すので、幅でも一覧に切り替える
 */
const ALIGN_WIDTH = 600;
/** 片と片のあいだ（.formula-grid の column-gap） */
const ALIGN_GAP = 5;

/** 字の幅の目安（12px の字で、全角は 12px、半角は 7px） */
const textWidth = (text: string) => [...text].reduce((w, ch) => w + (/[\u0000-\u00ff]/.test(ch) ? 7 : 12), 0);

/** そろえた形の幅の目安。列ごとに、上の行と下の行の広いほう */
export function alignedWidth(name: string, value: string, tokens: FormulaToken[]): number {
  const cols = [[name, value], ["=", "="], ...tokens.map((t) => [t.text, t.kind === "ref" && !t.held && t.value !== undefined ? t.value : t.text])];
  return cols.reduce((w, [top, bottom]) => w + Math.max(textWidth(top!), textWidth(bottom!)), 0) + ALIGN_GAP * (cols.length - 1);
}

/** そろえた形にするか、一覧にするか */
const layoutOf = (name: string, value: string, tokens: FormulaToken[], multiline = false): FormulaView["layout"] =>
  multiline || tokens.length > ALIGN_LIMIT || alignedWidth(name, value, tokens) > ALIGN_WIDTH ? "list" : "aligned";

/** 演算子の見せ方（式の書き方より、ふつうの算数の記号に近づける） */
const OP_TEXT: Record<string, string> = { "<-": "←", "*": "×", "/": "÷", "-": "−", "<=": "≤", ">=": "≥", "<>": "≠", "!=": "≠", "==": "=" };

const OPERATORS = ["<-", "<=", ">=", "<>", "!=", "==", "&&", "||", "+", "-", "*", "/", "^", "<", ">", "=", "!", "%"];

/**
 * 式を片に分ける。分けられないところ（文字列など）は other として、そのまま出す。
 * multiline は、式が複数の行や文に分かれている・コメントを含むか（下の行をそろえられない）
 */
export function tokenize(equation: string): { tokens: Omit<FormulaToken, "value" | "raw" | "held">[]; multiline: boolean } {
  const tokens: Omit<FormulaToken, "value" | "raw" | "held">[] = [];
  let multiline = /\n/.test(equation.trim());
  let i = 0;
  const s = equation;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = s.slice(i);
    let m: RegExpMatchArray | null;
    // コメントは飛ばす。コメントや複数の文があれば、下の行をそろえない（一覧にする）
    if (c === "#" || rest.startsWith("//")) {
      multiline = true;
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      multiline = true;
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === ";") {
      multiline = true;
      tokens.push({ kind: "other", text: ";" });
      i++;
      continue;
    }
    if (c === "[" && (m = rest.match(/^\[([^[\]\n]+)\]/))) {
      tokens.push({ kind: "ref", text: m[1]!.trim() });
      i += m[0].length;
    } else if (c === "{" && (m = rest.match(/^\{[^{}]*\}/))) {
      tokens.push({ kind: "num", text: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i))) {
      tokens.push({ kind: "num", text: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^("[^"]*"|'[^']*')/))) {
      tokens.push({ kind: "other", text: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^\.[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/))) {
      // 後ろに書く関数（[A].PastMax() など）
      tokens.push({ kind: "func", text: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/))) {
      const isFunc = /^\s*\(/.test(rest.slice(m[0].length));
      tokens.push({ kind: isFunc ? "func" : "other", text: m[0] });
      i += m[0].length;
    } else if (c === "(" || c === ")") {
      tokens.push({ kind: "paren", text: c });
      i++;
    } else if (c === ",") {
      tokens.push({ kind: "comma", text: "," });
      i++;
    } else {
      const op = OPERATORS.find((o) => rest.startsWith(o));
      if (op) {
        tokens.push({ kind: "op", text: OP_TEXT[op] ?? op });
        i += op.length;
      } else {
        // 名前を括弧なしで書いた局所の変数など。区切りまでを 1 つの片にする
        m = rest.match(/^[^\s[\](){},+\-*/^<>=!%]+/);
        const text = m ? m[0] : c;
        tokens.push({ kind: "other", text });
        i += text.length;
      }
    }
  }
  return { tokens, multiline };
}

/**
 * 時間をまたぐ関数の 1 つ目の引数にある参照の位置。
 * 関数の名前の次の「(」から、深さが同じ「,」か「)」までが 1 つ目の引数
 */
function heldPositions(tokens: Omit<FormulaToken, "value" | "raw" | "held">[]): Set<number> {
  const held = new Set<number>();
  // 開いている括弧ごとに、時間をまたぐ関数の 1 つ目の引数の中か
  const stack: boolean[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "paren" && t.text === "(") {
      const prev = tokens[i - 1];
      stack.push(!!prev && prev.kind === "func" && TIME_FUNCTIONS.has(prev.text.toLowerCase()));
    } else if (t.kind === "paren") {
      stack.pop();
    } else if (t.kind === "comma" && stack.length) {
      stack[stack.length - 1] = false;
    } else if (t.kind === "ref" && stack.some((x) => x)) {
      held.add(i);
    }
    // 後ろに書く時間をまたぐ関数（[A].PastMax() など）に渡す参照
    const next = tokens[i + 1];
    if (t.kind === "ref" && next?.kind === "func" && next.text.startsWith(".") && TIME_FUNCTIONS.has(next.text.slice(1).toLowerCase())) held.add(i);
  }
  return held;
}

const finite = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** series を名前（nameKey）で引けるようにする */
function lookup(series: Record<string, (number | null)[]>, at: number) {
  const byKey = new Map(Object.entries(series).map(([k, vs]) => [nameKey(k), vs]));
  return (name: string): number | undefined => {
    const v = byKey.get(nameKey(name))?.[at];
    return finite(v) ? v : undefined;
  };
}

/** 参照の片に値を入れる */
function withValue(name: string, raw: number | undefined): FormulaToken {
  return raw === undefined ? { kind: "ref", text: name } : { kind: "ref", text: name, value: formatValue(raw), raw };
}

/** 参照ごとの値（重なりなし、出てくる順） */
function refList(tokens: FormulaToken[]): FormulaView["refs"] {
  const seen = new Map<string, FormulaView["refs"][number]>();
  for (const t of tokens) {
    if (t.kind !== "ref") continue;
    const key = nameKey(t.text);
    const prev = seen.get(key);
    // 時間をまたぐ関数にも、ふつうにも渡している参照は、値を出す
    if (!prev || (prev.held && !t.held)) seen.set(key, { name: t.text, value: t.held ? "（過去の値を使います）" : (t.value ?? "—"), held: t.held || undefined });
  }
  return [...seen.values()];
}

/** ストック：出入りするフローの値で「入る量 − 出る量」 */
function stockView(model: Pick<ModelJSON, "elements">, el: ModelElement, value: (name: string) => number | undefined): FormulaView {
  const name = `${el.name}の増え方`;
  const flows = model.elements.filter((e) => e.type === "FLOW" && e.name);
  const inflows = flows.filter((f) => nameKey(f.to ?? "") === nameKey(el.name!));
  const outflows = flows.filter((f) => nameKey(f.from ?? "") === nameKey(el.name!));
  if (!inflows.length && !outflows.length) return { name, value: "—", tokens: [], layout: "aligned", refs: [], note: "出入りするフローがありません" };
  const tokens: FormulaToken[] = [];
  let sum: number | undefined = 0;
  for (const [list, sign] of [
    [inflows, 1],
    [outflows, -1],
  ] as const) {
    for (const f of list) {
      const raw = value(f.name!);
      // 入る量はあいだに「+」、出る量は「−」でつなぐ（入る量がなければ「− 出る量」から始める）
      if (tokens.length || sign < 0) tokens.push({ kind: "op", text: sign > 0 ? "+" : "−" });
      tokens.push(withValue(f.name!, raw));
      sum = sum === undefined || raw === undefined ? undefined : sum + sign * raw;
    }
  }
  const value_ = formatValue(sum);
  return { name, value: value_, raw: sum, tokens, layout: layoutOf(name, value_, tokens), refs: refList(tokens) };
}

/**
 * 選んだ要素の、値を入れた式。series の at 番目の時点の値を使う。
 * 式を出さない要素（変換器、状態など）や、見つからない要素は undefined
 */
export function formulaView(
  model: Pick<ModelJSON, "elements">,
  element: string,
  series: Record<string, (number | null)[]>,
  at: number,
): FormulaView | undefined {
  const el = model.elements.find((e) => e.type !== "LINK" && e.name && nameKey(e.name) === nameKey(element));
  if (!el) return undefined;
  const value = lookup(series, at);
  if (el.type === "STOCK") return stockView(model, el, value);
  if (el.type !== "VARIABLE" && el.type !== "FLOW") return undefined;
  const raw = value(el.name!);
  const eq = el.behavior?.value;
  const base = { name: el.name!, value: formatValue(raw), raw };
  // 式が数だけ（決まった値）のときは、値だけを出す
  if (typeof eq !== "string") return { ...base, tokens: [], layout: "aligned", refs: [] };
  const { tokens: parts, multiline } = tokenize(eq);
  if (parts.length <= 1 && !referencesIn(eq).length) return { ...base, tokens: [], layout: "aligned", refs: [] };
  const held = heldPositions(parts);
  const tokens = parts.map((t, i): FormulaToken => (t.kind !== "ref" ? t : held.has(i) ? { ...t, held: true } : withValue(t.text, value(t.text))));
  const layout = layoutOf(base.name, base.value, tokens, multiline);
  return { ...base, tokens, layout, refs: refList(tokens) };
}

/** 式を 1 行の文字にする（参照の括弧を外す）。一覧のときの上の行に使う */
export function formulaText(tokens: FormulaToken[]): string {
  let out = "";
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    // 「,」「)」「.関数」の前と、「(」と関数の名前の後ろは空けない
    const tight = !prev || t.kind === "comma" || (t.kind === "paren" && t.text === ")") || (prev.kind === "paren" && prev.text === "(") || (t.text === "(" && prev.kind === "func") || (t.kind === "func" && t.text.startsWith("."));
    out += tight ? t.text : ` ${t.text}`;
  });
  return out;
}
