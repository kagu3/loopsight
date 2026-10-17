import { copyFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { ModelStore, formatReadable } from "../src/core/index.js";
import { loadModelResponse } from "../src/viewer/server.js";
import { hasFigure, slideCSV, slideFileBase, slidesMarkdown } from "../src/viewer/slides-export.js";
import { tempDir } from "./helpers.js";

/** 例の population（モデル、実際のデータ、筋書き）を作業フォルダに写して、ビューアと同じ形で読む */
async function population() {
  const dir = await tempDir();
  for (const f of ["population.json", "population.data.csv", "population.slides.json"]) await copyFile(path.resolve("examples", f), path.join(dir, f));
  const data = await loadModelResponse(new ModelStore(dir), "population");
  return { data, deck: data.slides!.deck! };
}

const rows = (csv: string) => csv.trimEnd().split("\r\n").map((l) => l.split(","));

describe("説明資料の書き出し（slides.md と CSV）", () => {
  test("値は読みやすく丸める（1,000 以上は整数、それより小さい値は上から 4 桁）", () => {
    expect(formatReadable(2691.588)).toBe("2,692");
    expect(formatReadable(12.3456)).toBe("12.35");
    expect(formatReadable(0.025)).toBe("0.025");
    expect(formatReadable(-1234.5)).toBe("−1,235");
    expect(formatReadable(-0.5)).toBe("−0.5");
    expect(formatReadable(null)).toBe("—");
  });

  test("ファイル名は <2 桁の番号>-<種類>。画像は問題・原因・比較のスライドだけ", async () => {
    const { deck } = await population();
    expect(deck.slides.map((s, i) => slideFileBase(i, s))).toEqual(["01-problem", "02-cause", "03-cause", "04-solution", "05-solution", "06-compare", "07-conclusion"]);
    expect(deck.slides.map(hasFigure)).toEqual([true, true, true, false, false, true, false]);
  });

  test("CSV は問題と比較のスライドだけ。値はビューアのグラフと同じで丸めず、実際のデータのない時点は空にする", async () => {
    const { data, deck } = await population();
    const run = data.run!;
    expect(deck.slides.map((s) => slideCSV(data, s) !== undefined)).toEqual([true, false, false, false, false, true, false]);

    const problem = rows(slideCSV(data, deck.slides[0]!)!);
    expect(problem[0]).toEqual(["時間", "Population（モデル）", "Population（実際のデータ）"]);
    expect(problem.slice(1).map((r) => Number(r[0]))).toEqual(run.times);
    expect(problem.slice(1).map((r) => Number(r[1]))).toEqual(run.series.Population);
    const actual = data.actual!;
    for (const r of problem.slice(1)) {
      const j = actual.times.indexOf(Number(r[0]));
      expect(r[2]).toBe(j >= 0 && actual.series.Population![j] != null ? String(actual.series.Population![j]) : "");
    }

    const compare = rows(slideCSV(data, deck.slides[5]!)!);
    expect(compare[0]).toEqual(["時間", "Population（元のモデル）", "Population（家族計画の支援）", "Population（少しずつ支援する）"]);
    const scenario = data.scenarios!.find((s) => s.name === "家族計画の支援")!;
    expect(compare.slice(1).map((r) => Number(r[2]))).toEqual(scenario.series!.Population);
  });

  test("時刻が多くても、CSV はすぐに作れる", async () => {
    const { data, deck } = await population();
    const n = 10_001;
    const times = Array.from({ length: n }, (_, i) => i * 0.01);
    const big = { ...data, run: { ...data.run!, times, series: { Population: times.map((t) => t * 2) } }, actual: { ...data.actual!, times: [0.005, 50], series: { Population: [1, 2] } } };
    const started = performance.now();
    const csv = rows(slideCSV(big, deck.slides[0]!)!);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(csv).toHaveLength(n + 2);
    expect(csv[1]).toEqual(["0", "0", ""]);
    expect(csv[2]).toEqual(["0.005", "", "1"]);
    expect(csv.find((r) => r[0] === "50")).toEqual(["50", "100", "2"]);
  });

  test("slides.md には、スライドごとの中身と、画像と CSV へのリンクを書く。比較の値は画面と同じ丸め方", async () => {
    const { data, deck } = await population();
    const files = deck.slides.map((s, i) => ({
      ...(hasFigure(s) ? { image: `images/${slideFileBase(i, s)}.png` } : {}),
      ...(slideCSV(data, s) ? { data: `data/${slideFileBase(i, s)}.csv` } : {}),
    }));
    const md = slidesMarkdown(data, deck, { exportedAt: new Date(2026, 9, 18, 9, 5), pdf: "slides.pdf", files });
    expect(md).toMatch(/^# 人口の見通しと、家族計画の支援\n/);
    expect(md).toMatch(/- 書き出した日時：2026-10-18 09:05\n/);
    expect(md).toMatch(/## 1\. 問題：人口は 30 年で 1\.9 倍になり[^\n]*\n\n言いたいこと：/);
    expect(md).toMatch(/- 「今」の時点：30 年\n- 重ねた実際のデータ：Population\n- 画像：\[images\/01-problem\.png\]\(images\/01-problem\.png\)\n- グラフの値（CSV）：\[data\/01-problem\.csv\]\(data\/01-problem\.csv\)/);
    expect(md).toMatch(/- ループ：Population → Deaths → Population\n- ループの種類：釣り合わせるループ（B）/);
    expect(md).toMatch(/\| Birth Rate \| 0\.03 \| 0\.02 \|/);
    const base = data.run!.series.Population!.at(-1)!;
    expect(md).toContain(`| Population | ${formatReadable(base)} | 1,645（−39%） | 2,105（−22%） |`);
    expect(md).toContain("| Population | 2,692 |");
    // 結論は文章だけ
    expect(md.split("## 7. 結論：結論\n")[1]).toMatch(/^\n言いたいこと：[^\n]+\n$/);
    // 見出しと画像の説明の Markdown の記号は逃がす
    const odd = { ...deck, slides: [{ ...deck.slides[0]!, title: "[A]*強調*" }] };
    const oddMd = slidesMarkdown(data, odd, { exportedAt: new Date(), pdf: "slides.pdf", files: [{ image: "images/01-problem.png" }] });
    const b = String.fromCharCode(92); // バックスラッシュ
    expect(oddMd).toContain(`## 1. 問題：${b}[A${b}]${b}*強調${b}*`);
    expect(oddMd).toContain(`![${b}[A${b}]${b}*強調${b}*](images/01-problem.png)`);
    // 式は出さない
    expect(md).not.toMatch(/\[Population\]|\*/);
  });
});
