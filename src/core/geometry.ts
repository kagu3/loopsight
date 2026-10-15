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
