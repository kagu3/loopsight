import { describe, expect, test } from "vitest";
import { emptyModel, MAX_LOOPS, upsertElements } from "../src/core/index.js";
import { countLoops, listLoops, loopKey, truncatedText } from "../web/src/loopList.js";

describe("左の欄の「ループ」の一覧", () => {
  test("ループの鍵は、どこから回り始めても、大文字と小文字が違っても同じ。回る向きが違えば別", () => {
    expect(loopKey(["B", "C", "A"])).toBe(loopKey(["a", "b", "c"]));
    expect(loopKey(["A", "C", "B"])).not.toBe(loopKey(["A", "B", "C"]));
  });

  test("極性を変えて R / B と名前が変わっても、鍵は同じ（目立たせたままにできる）", () => {
    const m = emptyModel("t");
    upsertElements(m, [
      { type: "VARIABLE", name: "A", behavior: { value: "[B]" } },
      { type: "VARIABLE", name: "B", behavior: { value: "[A]" } },
    ]);
    const before = listLoops(m);
    expect(before.loops.map((l) => [l.name, l.kind])).toEqual([["?1", "unknown"]]);
    upsertElements(m, [
      { type: "LINK", from: "A", to: "B", behavior: { polarity: "POSITIVE" } },
      { type: "LINK", from: "B", to: "A", behavior: { polarity: "NEGATIVE" } },
    ]);
    const after = listLoops(m);
    expect(after.loops.map((l) => [l.name, l.kind])).toEqual([["B1", "B"]]);
    expect(after.loops[0]!.key).toBe(before.loops[0]!.key);
    expect(after.loops[0]!.view).toEqual({ name: "B1", kind: "B", elements: after.loops[0]!.elements });
    expect(countLoops(after.loops)).toEqual({ R: 0, B: 1, unknown: 0 });
  });

  test("探すのをやめたときの知らせ。数の上限は find_loops と同じ", () => {
    expect(truncatedText(false)).toBeUndefined();
    expect(truncatedText("loops")).toContain(`${MAX_LOOPS} 個`);
    expect(truncatedText("steps")).toMatch(/途中で/);
  });
});
