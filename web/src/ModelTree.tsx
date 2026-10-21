import type { CSSProperties } from "react";
import { folderKey, modelHash, type TreeNode } from "./modelList.js";

// 左の欄のモデルの一覧。作業フォルダの中のフォルダと同じ木の形に出す（モデル以外のファイルは出さない）。
// フォルダは押すと開け閉めでき、中のモデルの数を出す。開いているかどうかは App がブラウザに覚えておく。

interface Props {
  nodes: TreeNode[];
  /** 開いているモデルの名前 */
  current: string;
  /** 開いているフォルダ（folderKey） */
  open: Set<string>;
  onToggle: (path: string) => void;
  /** 何段目か（字下げに使う） */
  depth?: number;
}

export function ModelTree({ nodes, current, open, onToggle, depth = 0 }: Props) {
  const indent = { "--depth": depth } as CSSProperties;
  return (
    <ul className="model-list" role={depth ? "group" : undefined}>
      {nodes.map((n) => {
        if (n.kind === "model") {
          const m = n.model;
          return (
            <li key={`m:${m.name}`}>
              <a href={modelHash(m.name)} className={m.name.toLowerCase() === current.toLowerCase() ? "on" : ""} style={indent} title={m.name}>
                <span className="model-name">{n.label}</span>
                {m.title && m.title !== n.label && <span className="model-title">{m.title}</span>}
              </a>
            </li>
          );
        }
        const isOpen = open.has(folderKey(n.path));
        return (
          <li key={`f:${n.path}`}>
            <button className="folder-toggle" style={indent} onClick={() => onToggle(n.path)} aria-expanded={isOpen} title={n.path}>
              <span className="chevron">{isOpen ? "▾" : "▸"}</span>
              <span className="folder-name">{n.label}</span>
              <span className="count" title={`モデル ${n.count} 個（サブフォルダの中も含む）`}>
                {n.count}
              </span>
            </button>
            {isOpen &&
              (n.children.length ? (
                <ModelTree nodes={n.children} current={current} open={open} onToggle={onToggle} depth={depth + 1} />
              ) : (
                <p className="muted folder-empty" style={{ "--depth": depth + 1 } as CSSProperties}>
                  空のフォルダ
                </p>
              ))}
          </li>
        );
      })}
    </ul>
  );
}
