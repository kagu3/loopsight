// デモサイトに最初から入れる sample（examples/ のモデル）。ビルドのときに中身を埋め込む。
// モデル名は examples/ からの相対パス（例：0_コーヒーが冷める/coffee-cooling）。フォルダ名の番号の順に一覧に並ぶ
const files = import.meta.glob<string>("../../../examples/*/*.json", { query: "?raw", import: "default", eager: true });

export const SAMPLES: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([file, text]) => [file.replace(/^(\.\.\/)+examples\//, "").replace(/\.json$/, ""), text]),
);
