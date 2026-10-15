import type { ModelElement, ModelJSON, Point } from "./modeljson.js";
import { nameKey, sameName } from "./modeljson.js";

// 簡易レイアウト：Web 版に読み込んだとき要素が重ならない程度に座標を付ける。
// ストックを横一列に並べ（フローの流れ順）、変数はつながる要素の上か下に置く。

const SIZE: Record<string, Point> = {
  STOCK: [100, 40],
  VARIABLE: [120, 50],
  CONVERTER: [120, 50],
  STATE: [100, 40],
};
const NODE_TYPES = new Set(Object.keys(SIZE));
const STOCK_GAP = 300;
const MARGIN = 20;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function hasCoordinates(el: ModelElement): boolean {
  const c = el.display?.coordinates;
  return Array.isArray(c) && c.length === 2 && !(c[0] === 0 && c[1] === 0);
}

function rectOf(el: ModelElement): Rect | undefined {
  if (!hasCoordinates(el)) return undefined;
  const [x, y] = el.display!.coordinates!;
  const [w, h] = el.display?.size ?? SIZE[el.type] ?? [100, 50];
  return { x, y, w, h };
}

function center(r: Rect): Point {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + MARGIN && b.x < a.x + a.w + MARGIN && a.y < b.y + b.h + MARGIN && b.y < a.y + a.h + MARGIN;
}

/**
 * 座標のない要素に座標を付ける。モデルはその場で書き換える。
 * @returns 座標を付けた要素の名前
 */
export function layoutModel(model: ModelJSON): string[] {
  const placed: string[] = [];
  const occupied: Rect[] = [];
  const rects = new Map<string, Rect>();
  const nodes = model.elements.filter((e) => NODE_TYPES.has(e.type) && e.name);

  for (const el of nodes) {
    const r = rectOf(el);
    if (r) {
      occupied.push(r);
      rects.set(nameKey(el.name!), r);
    }
  }

  const isFree = (r: Rect) => !occupied.some((o) => overlaps(o, r));
  const place = (el: ModelElement, r: Rect) => {
    el.display = { ...(el.display ?? {}), coordinates: [Math.round(r.x), Math.round(r.y)], size: [r.w, r.h] };
    occupied.push(r);
    rects.set(nameKey(el.name!), r);
    placed.push(el.name!);
  };
  const bottom = () => (occupied.length ? Math.max(...occupied.map((o) => o.y + o.h)) : 0);

  // 1. ストック
  const flows = model.elements.filter((e) => e.type === "FLOW");
  const newStocks = orderStocks(model, flows).filter((s) => !rects.has(nameKey(s.name!)));
  const rowY = occupied.length ? bottom() + 260 : 260;
  let x = 100;
  for (const s of newStocks) {
    const [w, h] = SIZE.STOCK!;
    let r = { x, y: rowY, w, h };
    while (!isFree(r)) r = { ...r, x: r.x + STOCK_GAP };
    place(s, r);
    x = r.x + STOCK_GAP;
  }

  // 2. フローの雲（モデルの外の端）の位置。同じストックに複数あれば横にずらす
  const cloudCount = new Map<string, number>();
  for (const f of flows) {
    for (const end of ["from", "to"] as const) {
      const other = end === "from" ? f.to : f.from;
      const key = end === "from" ? "from_coordinates" : "to_coordinates";
      if (f[end] || f.display?.[key]) continue;
      const r = other ? rects.get(nameKey(other)) : undefined;
      if (!r) continue;
      const k = `${nameKey(other!)}:${end}`;
      const n = cloudCount.get(k) ?? 0;
      cloudCount.set(k, n + 1);
      const [cx] = center(r);
      const px = cx + n * 70;
      const py = end === "from" ? r.y - 110 : r.y + r.h + 110;
      f.display = { ...(f.display ?? {}), [key]: [Math.round(px), Math.round(py)] };
      occupied.push({ x: px - 15, y: py - 15, w: 30, h: 30 });
    }
  }

  // フローの中点（変数の置き場所の目安）
  const flowMid = (f: ModelElement): Point | undefined => {
    const end = (name: string | null | undefined, key: "from_coordinates" | "to_coordinates"): Point | undefined => {
      if (name) {
        const r = rects.get(nameKey(name));
        return r ? center(r) : undefined;
      }
      return f.display?.[key] as Point | undefined;
    };
    const a = end(f.from, "from_coordinates");
    const b = end(f.to, "to_coordinates");
    if (a && b) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return a ?? b;
  };

  const positionOf = (name: string): Point | undefined => {
    const r = rects.get(nameKey(name));
    if (r) return center(r);
    const f = flows.find((e) => sameName(e.name, name));
    return f ? flowMid(f) : undefined;
  };

  // 2b. 両端とも外にある座標なしのフロー
  for (const f of flows) {
    if (f.from || f.to || f.display?.from_coordinates || f.display?.to_coordinates) continue;
    let r = { x: 100, y: bottom() + 120, w: 200, h: 30 };
    while (!isFree(r)) r = { ...r, x: r.x + 250 };
    f.display = { ...(f.display ?? {}), from_coordinates: [r.x, r.y + 15], to_coordinates: [r.x + r.w, r.y + 15] };
    occupied.push(r);
  }

  // 3. 変数とコンバーター：リンクでつながる、位置の決まった要素の近くに置く
  const links = model.elements.filter((e) => e.type === "LINK");
  const neighbors = (name: string) =>
    links.flatMap((l) => (sameName(l.from, name) && l.to ? [l.to] : sameName(l.to, name) && l.from ? [l.from] : []));

  let pending = nodes.filter((e) => (e.type === "VARIABLE" || e.type === "CONVERTER") && !rects.has(nameKey(e.name!)));
  const stockTop = Math.min(rowY, ...[...rects.values()].map((r) => r.y));
  while (pending.length) {
    const next: ModelElement[] = [];
    let progressed = false;
    for (const el of pending) {
      const anchors = neighbors(el.name!).map(positionOf).filter((p): p is Point => !!p);
      if (!anchors.length) {
        next.push(el);
        continue;
      }
      const ax = anchors.reduce((s, p) => s + p[0], 0) / anchors.length;
      const ay = anchors.reduce((s, p) => s + p[1], 0) / anchors.length;
      const [w, h] = SIZE[el.type]!;
      place(el, findSpot(ax - w / 2, ay < stockTop + 20 ? ay - 120 - h / 2 : ay, w, h, isFree, stockTop));
      progressed = true;
    }
    if (!progressed) {
      // どこにもつながっていない要素は下にまとめて並べる
      let y = bottom() + 120;
      let px = 100;
      for (const el of next) {
        const [w, h] = SIZE[el.type]!;
        let r = { x: px, y, w, h };
        while (!isFree(r)) r = { ...r, x: r.x + w + 40 };
        place(el, r);
        px = r.x + w + 40;
        if (px > 100 + 6 * 160) {
          px = 100;
          y += h + 60;
        }
      }
      break;
    }
    pending = next;
  }

  // 4. 状態は一番下の行
  let sx = 100;
  const sy = bottom() + 140;
  for (const el of nodes.filter((e) => e.type === "STATE" && !rects.has(nameKey(e.name!)))) {
    const [w, h] = SIZE.STATE!;
    let r = { x: sx, y: sy, w, h };
    while (!isFree(r)) r = { ...r, x: r.x + 160 };
    place(el, r);
    sx = r.x + 160;
  }

  return placed;
}

/** 目安の位置の近くで空いている場所を探す。ストックの行より上を優先する。 */
function findSpot(x0: number, y0: number, w: number, h: number, isFree: (r: Rect) => boolean, stockTop: number): Rect {
  // 上端より上（負の座標）には置かない
  const ys = [stockTop - 150 - h, stockTop - 260 - h, stockTop + 200, stockTop + 310, stockTop - 370 - h, stockTop + 420].filter((y) => y >= MARGIN);
  // 目安の高さに近い段から試す
  ys.sort((a, b) => Math.abs(a - y0) - Math.abs(b - y0));
  for (let i = 0; i < 40; i++) {
    const dx = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * (w + 30);
    for (const y of ys) {
      const r = { x: Math.max(20, x0 + dx), y, w, h };
      if (isFree(r)) return r;
    }
  }
  return { x: x0, y: stockTop + 530, w, h };
}

/** ストックをフローの流れ順に並べる（つながりごとにまとめる） */
function orderStocks(model: ModelJSON, flows: ModelElement[]): ModelElement[] {
  const stocks = model.elements.filter((e) => e.type === "STOCK" && e.name);
  const byKey = new Map(stocks.map((s) => [nameKey(s.name!), s]));
  const out: ModelElement[] = [];
  const seen = new Set<string>();
  const hasInflowFromStock = (s: ModelElement) => flows.some((f) => sameName(f.to, s.name) && f.from && byKey.has(nameKey(f.from)));
  const roots = [...stocks.filter((s) => !hasInflowFromStock(s)), ...stocks];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const s = stack.shift()!;
      const k = nameKey(s.name!);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
      for (const f of flows) {
        if (sameName(f.from, s.name) && f.to && byKey.has(nameKey(f.to))) stack.push(byKey.get(nameKey(f.to))!);
      }
    }
  }
  return out;
}
