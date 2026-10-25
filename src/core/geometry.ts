// 図の形の計算。簡易レイアウト（layout.ts）、図への変換（diagram.ts）、図の確認（diagram-check.ts）で同じ形を使う。
import type { Point } from "./modeljson.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** リンクの線の曲げ具合。画面（web/src/Diagram.tsx）もこれで描く */
export const LINK_BEND = 0.18;

/** リンクを描く 2 次ベジェ曲線の制御点。両端の中心を結ぶ線から、横に少しずらす */
export function linkControlPoint(a: Point, b: Point): Point {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return [mx - dy * LINK_BEND, my + dx * LINK_BEND];
}

/** リンクの曲線を、短い線分に分けたもの */
export function linkSegments(a: Point, b: Point, steps = 12): [Point, Point][] {
  const c = linkControlPoint(a, b);
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]);
  }
  return pts.slice(1).map((p, i) => [pts[i]!, p]);
}

/** 線分が長方形（の内側）を通るか。Liang–Barsky のクリッピングで調べる */
export function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  const [x0, y0] = a;
  const dx = b[0] - x0;
  const dy = b[1] - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, x0 - r.x],
    [dx, r.x + r.w - x0],
    [-dy, y0 - r.y],
    [dy, r.y + r.h - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return true;
}

/**
 * フローの名前が描かれる範囲（画面と同じ：縦向きのフローは弁の右、横向きは弁の下）。
 * 弁は両端の中心を結ぶ線の真ん中にある。
 */
export function flowLabelRect(name: string, a: Point, b: Point): Rect {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  // 12px の文字。全角はおよそ 12px、半角はおよそ 7px
  const w = [...name].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? 12 : 7), 0) + 4;
  const h = 16;
  const valveHalf = 9;
  return Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0])
    ? { x: mx + valveHalf + 6, y: my - h / 2, w, h }
    : { x: mx - w / 2, y: my + valveHalf + 3, w, h };
}

/** 文字列の幅のおおよそ。全角は文字の大きさと同じ、半角はその 7/12 ほど */
export function textWidth(text: string, fontSize: number): number {
  return [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? fontSize : (fontSize * 7) / 12), 0);
}

// 箱の名前の文字（画面の .node と同じ 13px。行の高さは 1.2 倍）
const LABEL_FONT = 13;
const LABEL_LINE = LABEL_FONT * 1.2;
/** 名前の左右のすき間（内側の余白、枠の線、少しのゆとり） */
const LABEL_PAD = 10;
/** 名前がこの幅（全角 9 文字ほど）より長ければ 2 行にする */
const WRAP_WIDTH = 120;

/** 名前が 1 行のときの箱の大きさ。名前が短くても、これより小さくはしない */
const BOX_SIZE: Record<string, Point> = {
  STOCK: [100, 40],
  VARIABLE: [120, 50],
  CONVERTER: [120, 50],
};
/** 名前が 2 行のときの箱の高さ（ストックは下に値も出すので、そのぶんも入れる） */
const TWO_LINE_HEIGHT: Record<string, number> = {
  STOCK: 56,
  VARIABLE: 60,
  CONVERTER: 60,
};

/** 箱になる要素の種類 */
export const BOX_TYPES: ReadonlySet<string> = new Set(Object.keys(BOX_SIZE));

const isHiragana = (ch: string) => ch >= "\u3040" && ch <= "\u309f";
const isSpace = (ch: string) => ch === " " || ch === "\u3000";

/**
 * 名前を 2 行に分けてよいところ（2 行目の始まりの位置）。言葉の途中では分けない。
 * - 空白（半角か全角）のあと
 * - ひらがなから、漢字やカタカナ、英数字に変わるところ（「管理者が|考える|必要な|人数」）
 */
function breakPoints(name: string): number[] {
  const chars = [...name];
  const out: number[] = [];
  for (let i = 1; i < chars.length; i++) {
    const prev = chars[i - 1]!;
    const ch = chars[i]!;
    if (isSpace(ch)) continue;
    if (isSpace(prev) ||(isHiragana(prev) && !isHiragana(ch) && !"ー・、。）」』".includes(ch))) out.push(i);
  }
  return out;
}

/**
 * 名前の行。maxWidth に収まれば 1 行、収まらなければ言葉の切れ目で 2 行に分ける（長いほうの行がいちばん短くなるところで）。
 * 分けられるところがなければ 1 行のまま（箱を広げる）。
 */
export function labelLines(name: string, maxWidth = WRAP_WIDTH): string[] {
  if (textWidth(name, LABEL_FONT) <= maxWidth) return [name];
  const chars = [...name];
  let best: string[] | undefined;
  let bestWidth = Infinity;
  for (const i of breakPoints(name)) {
    const lines = [chars.slice(0, i).join("").trimEnd(), chars.slice(i).join("").trimStart()];
    const w = Math.max(...lines.map((l) => textWidth(l, LABEL_FONT)));
    if (w < bestWidth) {
      best = lines;
      bestWidth = w;
    }
  }
  return best ?? [name];
}

/** 文字の固まりが入る楕円の幅の割合（文字の上下の端で、楕円がどれだけ狭くなるか） */
const ellipseRatio = (textHeight: number, height: number) => Math.sqrt(Math.max(0.1, 1 - (textHeight / height) ** 2));
/** ストックの名前の下に出す値の行の高さ（画面の .node-value と同じ 12px） */
const VALUE_LINE = 12 * 1.2;
/** 名前の上下のすき間（画面の .node-body の内側の余白） */
const BODY_PAD_Y = 4;

/**
 * 強調した要素（display.emphasis）を描く倍率。箱の大きさも名前の文字も、この倍率で大きくする（画面の .node.is-emphasis と同じ）。
 * 文字と箱を同じ倍率で大きくするので、名前の行の分け方はふつうのときと変わらない
 */
export const EMPHASIS_SCALE = 1.4;

/**
 * 箱の大きさと、名前の行。簡易レイアウト（layout.ts）、図への変換（diagram.ts）、図の確認で同じものを使う。
 * - size（モデルの display.size）があればその大きさにし、名前はその幅に収まるように行を分ける。
 *   それでも入らなければ fits を false にする（画面は前と同じく、箱の中で折り返して描く）
 * - なければ名前の長さから幅を決める。長い名前は 2 行までにする
 * - emphasis（強調）なら、上で決めた大きさを EMPHASIS_SCALE 倍にする。size を指定した要素も、その大きさを基準に大きくする
 * 変数は楕円なので、文字の上下の端でも枠からはみ出さない幅にする。
 */
export function boxLayout(type: string, name: string, size?: Point, emphasis = false): { size: Point; lines: string[]; fits: boolean } {
  const base = plainBoxLayout(type, name, size);
  if (!emphasis) return base;
  const [w, h] = base.size;
  return { ...base, size: [Math.ceil(w * EMPHASIS_SCALE), Math.ceil(h * EMPHASIS_SCALE)] };
}

/** ふつう（強調なし）の箱の大きさと、名前の行 */
function plainBoxLayout(type: string, name: string, size?: Point): { size: Point; lines: string[]; fits: boolean } {
  const ellipse = type === "VARIABLE";
  /** 幅 w、高さ h の箱で、n 行の名前の 1 行に使える幅 */
  const room = (w: number, h: number, n: number) => (ellipse ? w * ellipseRatio(n * LABEL_LINE, h) : w) - 2 * LABEL_PAD;
  if (size) {
    const [w, h] = size;
    const lines = labelLines(name, room(w, h, 1));
    const widest = Math.max(...lines.map((l) => textWidth(l, LABEL_FONT)));
    const tall = lines.length * LABEL_LINE + (type === "STOCK" ? VALUE_LINE : 0) + BODY_PAD_Y;
    return { size, lines, fits: widest <= room(w, h, lines.length) && tall <= h };
  }
  const [minW, oneLineH] = BOX_SIZE[type] ?? [100, 50];
  const lines = labelLines(name);
  const h = lines.length > 1 ? (TWO_LINE_HEIGHT[type] ?? oneLineH) : oneLineH;
  const text = Math.max(...lines.map((l) => textWidth(l, LABEL_FONT))) + 2 * LABEL_PAD;
  const w = ellipse ? text / ellipseRatio(lines.length * LABEL_LINE, h) : text;
  return { size: [Math.max(minW, Math.ceil(w)), h], lines, fits: true };
}

// 注釈の文字（画面の .node-note と同じ 13px。行の高さは 1.4 倍）
const NOTE_FONT = 13;
const NOTE_LINE = NOTE_FONT * 1.4;
/** 注釈の文字のまわりのすき間（内側の余白と枠の線） */
const NOTE_PAD = 7;
/** 注釈を折り返す幅の既定と、決められる範囲 */
export const ANNOTATION_WIDTH = 200;
export const ANNOTATION_MIN_WIDTH = 60;
export const ANNOTATION_MAX_WIDTH = 800;
/** 行の頭に来ないようにする文字（前の行の終わりに付ける） */
const NO_LINE_START = "、。，．,.)）」』】ー・！？!?";

/**
 * 注釈の 1 文字の幅のおおよそ。textWidth より、英大文字（とくに W や M）を広めに見積もる（枠からはみ出さないように）。
 * 箱の名前の幅（textWidth）は図の配置に使っているので、変えない
 */
function noteCharWidth(ch: string, fontSize: number): number {
  if ("WMmw@".includes(ch)) return fontSize * 0.9;
  if (ch >= "A" && ch <= "Z") return fontSize * 0.72;
  return textWidth(ch, fontSize);
}

/**
 * 1 行の文字を、maxWidth に収まるように何行かに分ける。
 * 英数字の言葉は途中で分けない（空白で分ける）。句読点や閉じかっこは行の頭に来ないよう、前の行に付ける
 */
function wrapLine(line: string, maxWidth: number, fontSize: number): string[] {
  const chars = [...line];
  const out: string[] = [];
  let start = 0;
  let width = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = noteCharWidth(chars[i]!, fontSize);
    if (width + w <= maxWidth || i === start || NO_LINE_START.includes(chars[i]!)) {
      width += w;
      continue;
    }
    // 英数字の言葉の途中なら、その言葉の前の空白で分ける（行の中に空白がなければ、ここで分ける）
    let cut = i;
    if (/[\x21-\x7e]/.test(chars[i]!) && /[\x21-\x7e]/.test(chars[i - 1]!)) {
      const space = chars.lastIndexOf(" ", i - 1);
      if (space > start) cut = space + 1;
    }
    out.push(chars.slice(start, cut).join("").trimEnd());
    start = cut;
    while (start < chars.length && chars[start] === " ") start++;
    i = start - 1;
    width = 0;
  }
  out.push(chars.slice(start).join("").trimEnd());
  return out;
}

/**
 * 注釈の大きさと行。幅は width（なければ ANNOTATION_WIDTH）に決め、文字はその幅で折り返す。改行はそのまま行を分ける。
 * 図への変換（diagram.ts）と図の確認で同じものを使い、画面は行をそのまま描く（重なりの確認と見た目を合わせるため）
 */
export function annotationLayout(text: string, width?: number): { size: Point; lines: string[] } {
  const w = Math.min(ANNOTATION_MAX_WIDTH, Math.max(ANNOTATION_MIN_WIDTH, Math.round(width ?? ANNOTATION_WIDTH)));
  const lines = text.split(/\r?\n/).flatMap((line) => wrapLine(line, w - 2 * NOTE_PAD, NOTE_FONT));
  return { size: [w, Math.ceil(lines.length * NOTE_LINE + 2 * NOTE_PAD)], lines };
}
