// グラフに出す要素を選ぶ一覧の、React に依存しない計算。
// 一覧は種類ごとにまとめ、名前で絞り込む。

export interface SeriesCandidate {
  name: string;
  type: string;
}

export interface SeriesGroup {
  type: string;
  label: string;
  items: SeriesCandidate[];
}

/** まとめる順と見出し。ここにない種類は最後の「その他」にまとめる */
const GROUPS: { type: string; label: string }[] = [
  { type: "STOCK", label: "ストック" },
  { type: "FLOW", label: "フロー" },
  { type: "VARIABLE", label: "変数" },
  { type: "CONVERTER", label: "コンバーター" },
];
const OTHER = { type: "OTHER", label: "その他" };

/** 比べるための形。全角と半角、大文字と小文字の違いは見ない */
function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * 名前が絞り込みの言葉に合うか。
 * 空白で区切った言葉が、すべて名前に含まれていれば合う。空なら何でも合う
 */
export function matchesQuery(name: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const target = fold(name);
  return words.every((w) => target.includes(w));
}

/** 候補を種類ごとにまとめ、名前で絞り込む。中の並びは元の順のまま。空のまとまりは出さない */
export function groupCandidates(candidates: SeriesCandidate[], query = ""): SeriesGroup[] {
  const groups = [...GROUPS, OTHER].map((g) => ({ ...g, items: [] as SeriesCandidate[] }));
  const other = groups[groups.length - 1]!;
  for (const c of candidates) {
    if (!matchesQuery(c.name, query)) continue;
    (groups.find((g) => g.type === c.type) ?? other).items.push(c);
  }
  return groups.filter((g) => g.items.length > 0);
}
