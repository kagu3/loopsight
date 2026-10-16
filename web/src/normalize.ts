// グラフの「正規化」：大きさの違う要素を同じ縦軸に並べて、変わり方の形を比べるため。

/** 最小を 0、最大を 1 にする。ずっと同じ値なら真ん中（0.5）に置く。値のないところ（null）はそのまま */
export function normalize(values: (number | null)[]): (number | null)[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    return max > min ? (v - min) / (max - min) : 0.5;
  });
}

/**
 * いくつかの系列を、まとめて同じ物差しで正規化する（施策を重ねて比べるとき）。
 * 全部の系列を通した最小を 0、最大を 1 にするので、系列どうしの高さの違いは残る
 */
export function normalizeTogether(list: (number | null)[][]): (number | null)[][] {
  const lengths = list.map((v) => v.length);
  const all = normalize(list.flat());
  let at = 0;
  return lengths.map((n) => all.slice(at, (at += n)));
}
