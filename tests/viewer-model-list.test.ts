import { describe, expect, test } from "vitest";
import type { ModelInfo } from "../src/viewer/api.js";
import { foldersOf, modelHash, modelTree, type TreeNode } from "../web/src/modelList.js";

const model = (name: string): ModelInfo => ({
  name,
  folder: name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "",
  file: `${name}.json`,
  elements: 0,
  modified: "2026-01-01T00:00:00.000Z",
});

/** 木を「字下げ + 名前」の行にする（比較用） */
const lines = (nodes: TreeNode[], depth = 0): string[] =>
  nodes.flatMap((n) =>
    n.kind === "folder" ? [`${"  ".repeat(depth)}[${n.label}] ${n.count}`, ...lines(n.children, depth + 1)] : [`${"  ".repeat(depth)}${n.label}`],
  );

describe("モデルの一覧の木", () => {
  test("どの段もフォルダを先に、そのあとにモデルを名前順（数字は数の順）に並べる", () => {
    const tree = modelTree({
      models: [model("z"), model("ブルックスの法則/brooks_law_detailed"), model("ブルックスの法則/brooks_law"), model("事例/在庫/v10"), model("事例/在庫/v2"), model("a")],
      folders: [
        { name: "ブルックスの法則", models: 2 },
        { name: "事例", models: 2 },
        { name: "事例/在庫", models: 2 },
        { name: "empty", models: 0 },
      ],
    });
    expect(lines(tree)).toEqual([
      "[empty] 0",
      "[ブルックスの法則] 2",
      "  brooks_law",
      "  brooks_law_detailed",
      "[事例] 2",
      "  [在庫] 2",
      "    v2",
      "    v10",
      "a",
      "z",
    ]);
  });

  test("モデルが入っているフォルダと、アドレスの # に入れる名前", () => {
    expect(foldersOf("a/b/m")).toEqual(["a", "a/b"]);
    expect(foldersOf("m")).toEqual([]);
    expect(modelHash("ブルックスの法則/brooks law")).toBe(`#${encodeURIComponent("ブルックスの法則")}/brooks%20law`);
    expect(decodeURIComponent(modelHash("a/b").slice(1))).toBe("a/b");
  });
});
