// 図だけの画像（SVG と PNG）を書き出すときの、書き出し先とファイル名の決まり。
// MCP の export_diagram と、ビューアの図の「書き出す」ボタン（サーバーが受け取って書く）の両方で使う。
// 画像そのものは、画面の図（web/src/diagramExport.ts）が作る。
import path from "node:path";
import { StoreError, checkModelName, type ModelStore } from "../core/index.js";

/** 図の画像のファイル名（拡張子なし）の既定 */
export const DIAGRAM_FILE_BASE = "diagram";

/** 書き出し先のフォルダの既定（作業フォルダからの相対パス）。exports/<モデル名>（フォルダにあるモデルは exports/<フォルダ>/<名前>） */
export function exportFolderOf(name: string): string {
  return path.join("exports", ...checkModelName(name).split("/"));
}

/** ファイル名（拡張子なし）を確かめる。フォルダの区切りや、ファイル名に使えない文字は断る */
export function checkFileBase(base: string): string {
  const b = base.trim();
  if (!b || b === "." || b === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(b)) {
    throw new StoreError(`ファイル名 "${base}" は使えません。/ \\ : * ? " < > | を含まない名前にしてください（拡張子は付けない）。`);
  }
  return b.replace(/\.(svg|png)$/i, "");
}

export interface DiagramImages {
  svg?: string;
  png?: Uint8Array;
}

/** ほかのアプリで開かれていて書けないときの案内 */
const BUSY = "ファイルがほかのアプリ（画像のビューアやスライドのアプリなど）で開かれていないか確かめてから、もう一度書き出してください。";

/**
 * 図の画像を、作業フォルダの中のフォルダ rel に <base>.svg と <base>.png で書く。書いたファイルの絶対パスを返す。
 * 1 つずつ一時ファイルから置き換える（途中で止まっても壊れたファイルを残さない）
 */
export async function writeDiagramImages(store: ModelStore, rel: string, base: string, images: DiagramImages): Promise<{ dir: string; files: string[] }> {
  const dir = store.resolveInside(rel);
  if (path.relative(store.dir, dir) === "") throw new StoreError("作業フォルダそのものには書き出せません。exports/<モデル名> のようなフォルダを指定してください。");
  const name = checkFileBase(base);
  const files: string[] = [];
  const write = async (ext: string, data: string | Uint8Array) => {
    const file = path.join(dir, `${name}.${ext}`);
    try {
      files.push(typeof data === "string" ? await store.writeTextFile(file, data) : await store.writeBinaryFile(file, data));
    } catch (e) {
      throw new StoreError(`${name}.${ext} を書けませんでした（${(e as Error).message}）。${BUSY}`);
    }
  };
  if (images.svg !== undefined) await write("svg", images.svg);
  if (images.png !== undefined) await write("png", images.png);
  return { dir, files };
}
