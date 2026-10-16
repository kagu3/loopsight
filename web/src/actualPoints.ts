// 実際のデータの点を、グラフの行に入れる計算（React に依存しない）。
// Recharts は線ごとに別の行を持たせるとツールチップの時刻がずれるので、点も同じ行に入れる。
// データの時刻がモデルの刻みと合わないときは、その時刻の行を足す。足した行のモデルの値は前後の行から直線で補う
// （グラフの線は直線でつないでいるので、線の形は変わらない）。

export type ChartRow = Record<string, number | null>;

/** 同じ時刻とみなすか。刻みが 0.1 などのときの、小数の誤差を見ない */
export function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * rows（時刻 t の昇順）に、実際のデータの点を入れた新しい行を返す。
 * points は列の名前（行のキー）→ 点。足した行の i（モデルの行の番号）は null にする。
 * lineKeys はモデルの線のキーで、足した行では前後の行から補う（どちらかが null か、範囲の外なら null）
 */
export function withActualPoints(rows: ChartRow[], points: Map<string, { t: number; v: number }[]>, lineKeys: string[]): ChartRow[] {
  if (points.size === 0) return rows;
  const out = rows.map((r) => ({ ...r }));
  const added: ChartRow[] = [];
  for (const [key, list] of points) {
    for (const p of list) {
      const row = findRow(out, p.t) ?? findRow(added, p.t);
      if (row) {
        row[key] = p.v;
        continue;
      }
      const extra: ChartRow = { t: p.t, i: null, [key]: p.v };
      for (const k of lineKeys) extra[k] = interpolate(out, p.t, k);
      added.push(extra);
    }
  }
  return added.length ? [...out, ...added].sort((a, b) => a.t! - b.t!) : out;
}

function findRow(rows: ChartRow[], t: number): ChartRow | undefined {
  // 行は多くても数千なので、端から探す
  return rows.find((r) => sameTime(r.t!, t));
}

function interpolate(rows: ChartRow[], t: number, key: string): number | null {
  const next = rows.findIndex((r) => r.t! > t);
  if (next <= 0) return null;
  const a = rows[next - 1]!;
  const b = rows[next]!;
  const va = a[key];
  const vb = b[key];
  if (va == null || vb == null) return null;
  return va + ((vb - va) * (t - a.t!)) / (b.t! - a.t!);
}
