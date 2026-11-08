import { describe, expect, test } from "vitest";
import { firstParagraph } from "../web/src/description.js";

describe("上の帯に出す説明の最初の段落", () => {
  test("最初の空行の手前までを、改行を空白にして 1 行で返す", () => {
    expect(firstParagraph("【ひとことで】\n成長は止まる。\n\n【どんな問題か】\n長い説明")).toBe("【ひとことで】 成長は止まる。");
  });

  test("見出しがなくても、最初の段落を返す", () => {
    expect(firstParagraph("在庫が増えすぎる。\n\nくわしい説明")).toBe("在庫が増えすぎる。");
  });

  test("空行がなければ全体を返す", () => {
    expect(firstParagraph("1 行だけの説明")).toBe("1 行だけの説明");
  });

  test("頭の空行と、空白だけの行での区切り、Windows の改行も扱う", () => {
    expect(firstParagraph("\n\n  要点。\r\n続き。\r\n  \r\n次の段落")).toBe("要点。 続き。");
  });

  test("説明がないか空白だけなら空の文字列（帯は 1 行になる）", () => {
    expect(firstParagraph(undefined)).toBe("");
    expect(firstParagraph("")).toBe("");
    expect(firstParagraph(" \n \n")).toBe("");
  });
});
