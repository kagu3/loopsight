import { describe, expect, test } from "vitest";
import { emptyModel, MAX_LOOPS, removeElements, setLoops, upsertElements } from "../src/core/index.js";
import { countLoops, listLoops, loopKey, loopPath, splitLoops, truncatedText } from "../web/src/loopList.js";

describe("左の欄の「ループ」の一覧", () => {
  test("ループの鍵は、どこから回り始めても、大文字と小文字が違っても同じ。回る向きが違えば別", () => {
    expect(loopKey(["B", "C", "A"])).toBe(loopKey(["a", "b", "c"]));
    expect(loopKey(["A", "C", "B"])).not.toBe(loopKey(["A", "B", "C"]));
  });

  test("極性を変えて R / B と記号が変わっても、鍵は同じ（目立たせたままにできる）", () => {
    const m = emptyModel("t");
    upsertElements(m, [
      { type: "VARIABLE", name: "A", behavior: { value: "[B]" } },
      { type: "VARIABLE", name: "B", behavior: { value: "[A]" } },
    ]);
    const before = listLoops(m);
    expect(before.loops.map((l) => [l.symbol, l.kind])).toEqual([["?1", "unknown"]]);
    upsertElements(m, [
      { type: "LINK", from: "A", to: "B", behavior: { polarity: "POSITIVE" } },
      { type: "LINK", from: "B", to: "A", behavior: { polarity: "NEGATIVE" } },
    ]);
    const after = listLoops(m);
    expect(after.loops.map((l) => [l.symbol, l.kind])).toEqual([["B1", "B"]]);
    expect(after.loops[0]!.key).toBe(before.loops[0]!.key);
    expect(after.loops[0]!.view).toEqual({ name: "B1", kind: "B", elements: after.loops[0]!.elements });
    expect(countLoops(after.loops)).toEqual({ R: 0, B: 1, unknown: 0 });
  });

  test("名前を付けたループは上に出し、名前を大きく（札にも名前と記号）。名前のないループは「ほかの n 個」にたたむ", () => {
    const m = emptyModel("t");
    upsertElements(m, [
      { type: "VARIABLE", name: "A", behavior: { value: "[B]" } },
      { type: "VARIABLE", name: "B", behavior: { value: "[A] + [C]" } },
      { type: "VARIABLE", name: "C", behavior: { value: "[B]" } },
    ]);
    // 名前がなければ、全部をそのまま出す
    const plain = listLoops(m);
    expect(splitLoops(plain.loops)).toEqual({ shown: plain.loops, others: [] });
    setLoops(m, [{ name: "BとC", elements: ["C", "B"] }]);
    const list = listLoops(m);
    expect(list.loops.map((l) => [l.name, l.symbol])).toEqual([
      ["BとC", "?2"],
      [undefined, "?1"],
    ]);
    expect(list.loops[0]!.view).toEqual({ name: "BとC", symbol: "?2", kind: "unknown", elements: ["B", "C"] });
    const { shown, others } = splitLoops(list.loops);
    expect(shown.map((l) => l.name)).toEqual(["BとC"]);
    expect(others.map((l) => l.symbol)).toEqual(["?1"]);
    expect(list.missing).toEqual([]);
    // つながりを消して、名前を付けたループがなくなったら、画面から外せるように名前を出す
    removeElements(m, [{ from: "C", to: "B" }]);
    expect(listLoops(m)).toMatchObject({ missing: ["BとC"] });
    expect(listLoops(m).loops.map((l) => l.name)).toEqual([undefined]);
  });

  test("経路は、最後の始まりと同じ要素を省く", () => {
    expect(loopPath(["A", "B", "C"])).toBe("A → B → C");
  });

  test("探すのをやめたときの知らせ。数の上限は find_loops と同じ", () => {
    expect(truncatedText(false)).toBeUndefined();
    expect(truncatedText("loops")).toContain(`${MAX_LOOPS} 個`);
    expect(truncatedText("steps")).toMatch(/途中で/);
  });
});
