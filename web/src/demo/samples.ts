// デモサイトに最初から入れる sample（examples/ のモデル）。ビルドのときに中身を埋め込む。
// モデル名は examples/ からの相対パス（例：0_コーヒーが冷める/coffee-cooling）。フォルダ名の番号の順に一覧に並ぶ
const files = import.meta.glob<string>("../../../examples/*/*.json", { query: "?raw", import: "default", eager: true });
// 実際のデータ（<モデル名>.data.csv）も埋め込み、グラフに点で重ねる
const dataFiles = import.meta.glob<string>("../../../examples/*/*.data.csv", { query: "?raw", import: "default", eager: true });

const nameOf = (file: string, ext: RegExp) => file.replace(/^(\.\.\/)+examples\//, "").replace(ext, "");

export const SAMPLES: Record<string, string> = Object.fromEntries(Object.entries(files).map(([file, text]) => [nameOf(file, /\.json$/), text]));

/** モデル名 → 実際のデータ（CSV の中身） */
export const SAMPLE_DATA: Record<string, string> = Object.fromEntries(Object.entries(dataFiles).map(([file, text]) => [nameOf(file, /\.data\.csv$/), text]));
