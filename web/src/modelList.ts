// 左の欄のモデルの一覧を、フォルダごとの木の形にする（画面の部品とは分けて、テストできるようにする）
import type { FolderInfo, ModelInfo, ModelListResponse } from "../../src/viewer/api.js";

export interface FolderNode {
  kind: "folder";
  /** フォルダ名（作業フォルダからの相対パス、/ 区切り） */
  path: string;
  /** 一覧に出す名前（いちばん後ろの部分） */
  label: string;
  /** 中にあるモデルの数（サブフォルダの中も数える） */
  count: number;
  children: TreeNode[];
}

export interface ModelNode {
  kind: "model";
  model: ModelInfo;
  /** 一覧に出す名前（フォルダを除いた名前） */
  label: string;
}

export type TreeNode = FolderNode | ModelNode;

/** エクスプローラーと同じように、大文字と小文字を区別せず、数字は数の大きさの順に並べる（src/core/store.ts の compareNames と同じ） */
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
const byLabel = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const lastPart = (name: string) => name.slice(name.lastIndexOf("/") + 1);
const parentOf = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");

/** 一覧から木を作る。どの段も、フォルダを先に、そのあとにモデルを、名前順に並べる（エクスプローラーと同じ） */
export function modelTree(list: Pick<ModelListResponse, "models" | "folders">): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, FolderNode>();
  const childrenOf = (folder: string) => (folder ? folders.get(folder)?.children : root);
  // 親が先に来る並び（サーバーが親のすぐあとに子を入れる）だが、念のため浅い順に入れる
  const sorted: FolderInfo[] = [...(list.folders ?? [])].sort((a, b) => a.name.split("/").length - b.name.split("/").length);
  for (const f of sorted) {
    const node: FolderNode = { kind: "folder", path: f.name, label: lastPart(f.name), count: f.models, children: [] };
    folders.set(f.name, node);
    (childrenOf(parentOf(f.name)) ?? root).push(node);
  }
  for (const m of list.models) {
    (childrenOf(m.folder ?? parentOf(m.name)) ?? root).push({ kind: "model", model: m, label: lastPart(m.name) });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? byLabel(a.label, b.label) : a.kind === "folder" ? -1 : 1));
    for (const n of nodes) if (n.kind === "folder") sort(n.children);
  };
  sort(root);
  return root;
}

/** モデルが入っているフォルダ（親から順に）。例："a/b/m" → ["a", "a/b"] */
export function foldersOf(name: string): string[] {
  const parts = name.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** フォルダを開いているかを覚えるときのキー。大文字と小文字を区別しない（Windows と macOS のファイル名に合わせる） */
export const folderKey = (path: string) => path.toLowerCase();

/** アドレスの # に入れるモデル名。フォルダの区切りの / はそのまま残し、ほかは encodeURIComponent する（#ブルックスの法則/brooks_law） */
export const modelHash = (name: string) => `#${name.split("/").map(encodeURIComponent).join("/")}`;
