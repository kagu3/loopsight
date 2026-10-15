import { describe, expect, test } from "vitest";
import { groupCandidates, matchesQuery } from "../web/src/seriesPicker.js";

describe("グラフの要素の絞り込み", () => {
  test("空白で区切った言葉が、すべて名前に含まれていれば合う", () => {
    expect(matchesQuery("意思疎通に取られる割合", "意思疎通")).toBe(true);
    expect(matchesQuery("意思疎通に取られる割合", "意思疎通 割合")).toBe(true);
    expect(matchesQuery("意思疎通に取られる割合", "意思疎通 人数")).toBe(false);
  });

  test("空なら何でも合う。大文字と小文字、全角と半角は区別しない", () => {
    expect(matchesQuery("Population", "")).toBe(true);
    expect(matchesQuery("Population", "  ")).toBe(true);
    expect(matchesQuery("Birth Rate", "birth")).toBe(true);
    expect(matchesQuery("Birth Rate", "ＲＡＴＥ")).toBe(true);
    expect(matchesQuery("1 組あたりの意思疎通の手間", "１ 組")).toBe(true);
  });
});

describe("グラフの要素のまとめ方", () => {
  const candidates = [
    { name: "採用", type: "FLOW" },
    { name: "新人", type: "STOCK" },
    { name: "標準の生産性", type: "VARIABLE" },
    { name: "経験者", type: "STOCK" },
    { name: "効果", type: "CONVERTER" },
    { name: "段階", type: "STATE" },
  ];

  test("ストック、フロー、変数の順にまとめ、中は元の順のまま", () => {
    expect(groupCandidates(candidates).map((g) => [g.label, g.items.map((c) => c.name)])).toEqual([
      ["ストック", ["新人", "経験者"]],
      ["フロー", ["採用"]],
      ["変数", ["標準の生産性"]],
      ["コンバーター", ["効果"]],
      ["その他", ["段階"]],
    ]);
  });

  test("絞り込むと、合う要素のないまとまりは出さない", () => {
    expect(groupCandidates(candidates, "新人").map((g) => [g.label, g.items.map((c) => c.name)])).toEqual([["ストック", ["新人"]]]);
    expect(groupCandidates(candidates, "見つからない")).toEqual([]);
  });
});
