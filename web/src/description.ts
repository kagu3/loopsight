// 上の帯の 2 行目に出す、モデルの説明の頭（画面の部品とは分けて、テストできるようにする）

/**
 * 説明の最初の段落（最初の空行の手前まで）を 1 行にして返す。段落の中の改行は空白にする
 * （段落の中で改行していても、帯には 1 行で出すため。sample の決まりの「60 文字以内」も、これで数える）。見出しの有無は見ない。
 * 頭の空行は飛ばす。中身がなければ空の文字列を返す（帯は 1 行になる）
 */
export function firstParagraph(description: string | undefined): string {
  if (!description) return "";
  const paragraph = description.replace(/\r\n?/g, "\n").trim().split(/\n[ \t　]*\n/)[0] ?? "";
  return paragraph
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line)
    .join(" ");
}
