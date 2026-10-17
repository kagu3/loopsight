// export_slides で書き出すフォルダの中身のうち、文字のもの（slides.md と、グラフの値の CSV）を作る。
// 値は、ビューアの画面と同じもの（loadModelResponse の結果）から取る。画面のグラフと CSV の値、比較のスライドと slides.md の値がずれないように。
// 画像（images/）と PDF は、ヘッドレスのブラウザで発表モードを描いて作る（src/mcp/tools.ts）。
import { BASELINE_SCENARIO, LOOP_KIND_LABEL, SLIDE_KIND_LABEL, changeFrom, formatReadable, formatValue, sameName, valueAt, type Slide, type SlideDeck } from "../core/index.js";
import type { ModelResponse } from "./api.js";

/** 時間の単位の呼び名（web/src/Chart.tsx の TIME_UNIT_LABEL と同じ） */
const TIME_UNIT_LABEL: Record<string, string> = {
  seconds: "秒",
  minutes: "分",
  hours: "時間",
  days: "日",
  weeks: "週",
  months: "月",
  years: "年",
};

/** スライドのファイル名（拡張子なし）。<2 桁の番号>-<種類>。日本語の名前はほかのツールでつまずきやすいので英語にする */
export function slideFileBase(index: number, slide: Slide): string {
  return `${String(index + 1).padStart(2, "0")}-${slide.kind}`;
}

/** グラフや図だけの画像を作るスライドか。問題と比較はグラフ、原因は図。解決案と結論はグラフも図も出していないので作らない */
export function hasFigure(slide: Slide): boolean {
  return slide.kind === "problem" || slide.kind === "compare" || slide.kind === "cause";
}

function unitOf(data: ModelResponse): string {
  const u = data.run?.time_units ?? data.model.simulation?.time_units ?? "";
  return TIME_UNIT_LABEL[u.toLowerCase()] ?? u;
}

/** 時刻は桁区切りなし（web の formatTime と同じ） */
function formatTime(t: number): string {
  return t.toLocaleString("ja-JP", { useGrouping: false, maximumFractionDigits: 4 });
}

function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function elementName(data: ModelResponse, name: string): string | undefined {
  return data.model.elements.find((e) => e.type !== "LINK" && e.name && sameName(e.name, name))?.name;
}

/** 比較のスライドで重ねる実行（先頭が「元のモデル」）。画面（web/src/Present.tsx の CompareBody）と同じ並びと注記 */
function compareRuns(data: ModelResponse, slide: Extract<Slide, { kind: "compare" }>) {
  const out: { name: string; series?: Record<string, (number | null)[]>; baseline: boolean; note: string }[] = [
    { name: BASELINE_SCENARIO, series: data.run?.series, baseline: true, note: "" },
  ];
  for (const name of slide.scenarios) {
    const s = data.scenarios?.find((x) => sameName(x.name, name));
    const note = !s ? "モデルにありません" : s.error ? "実行できませんでした" : s.skipped ? "ビューアで実行していません" : "";
    out.push({ name: s?.name ?? name, series: s?.series, baseline: false, note });
  }
  return out;
}

interface Column {
  name: string;
  /** [時刻, 値] の並び（時刻の昇順） */
  points: [number, number | null][];
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * グラフの線の値の CSV（問題と比較のスライドだけ。ほかは undefined）。1 列目は「時間」、続けて線ごとに 1 列。
 * 値は丸めない。値のない時点（実際のデータがない時点など）は空にする。先頭に BOM は付けない（書くときに付ける）
 */
export function slideCSV(data: ModelResponse, slide: Slide): string | undefined {
  const run = data.run;
  if (!run || (slide.kind !== "problem" && slide.kind !== "compare")) return undefined;
  const columns: Column[] = [];
  const modelColumn = (name: string, values: (number | null)[]): Column => ({ name, points: run.times.map((t, i) => [t, values[i] ?? null]) });
  if (slide.kind === "problem") {
    // 画面（ProblemBody）と同じく、data を指定していればその列だけ、なければ実際のデータのある要素すべての点を重ねる
    const withData = (n: string) => (slide.data ? slide.data.some((d) => sameName(d, n)) : true);
    for (const raw of slide.elements) {
      const n = elementName(data, raw);
      const series = n ? run.series[n] : undefined;
      if (!n || !series) continue;
      columns.push(modelColumn(`${n}（モデル）`, series));
      const actual = data.actual?.series[n];
      if (actual && withData(n) && actual.some((v) => v != null)) {
        const points = data.actual!.times.flatMap((t, i): [number, number][] => (actual[i] == null ? [] : [[t, actual[i]!]]));
        columns.push({ name: `${n}（実際のデータ）`, points: points.sort((a, b) => a[0] - b[0]) });
      }
    }
  } else {
    const runs = compareRuns(data, slide);
    for (const raw of slide.elements) {
      const n = elementName(data, raw);
      if (!n || !run.series[n]) continue;
      for (const r of runs) if (r.series?.[n]) columns.push(modelColumn(`${n}（${r.name}）`, r.series[n]));
    }
  }
  if (!columns.length) return undefined;
  // 時刻：モデルの刻みに、実際のデータの時刻を足す（画面のグラフと同じ）
  // 並べ替えてから、同じとみなす時刻をまとめる（どれも時刻の昇順なので、端から突き合わせる）
  const times: number[] = [];
  for (const t of columns.flatMap((c) => c.points.map((p) => p[0])).sort((a, b) => a - b)) {
    if (!times.length || !sameTime(times.at(-1)!, t)) times.push(t);
  }
  const cells = columns.map((c) => {
    const out: string[] = new Array(times.length).fill("");
    let j = 0;
    for (const [t, v] of c.points) {
      while (j < times.length - 1 && !sameTime(times[j]!, t) && times[j]! < t) j++;
      if (v != null) out[j] = String(v);
    }
    return out;
  });
  const lines = [["時間", ...columns.map((c) => c.name)].map(csvField).join(",")];
  times.forEach((t, i) => lines.push([String(t), ...cells.map((c) => c[i]!)].map(csvField).join(",")));
  return lines.join("\r\n") + "\r\n";
}

/** 表のセル。| と改行を逃がす */
function cell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function table(head: string[], rows: string[][]): string[] {
  return [`| ${head.map(cell).join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

/** シナリオで変える値。画面（web/src/Present.tsx の showValue）と同じ書き方。式は見せないので、数でなければ「計算で決まる」 */
function showEquation(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? formatValue(n) : "計算で決まる";
}

/** 見出しや画像の説明に入れる文。Markdown の記号（[ ] * _ など）が書式にならないよう逃がす */
function inline(text: string): string {
  const mark = String.fromCharCode(92); // バックスラッシュ
  return text
    .split(mark)
    .join(mark + mark)
    .replace(/[`*_<>#|[\]]/g, (c) => mark + c)
    .replace(/\r?\n/g, " ");
}

function dateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface SlideFiles {
  /** 画像の相対パス（images/01-problem.png など）。作らなかったときはない */
  image?: string;
  /** CSV の相対パス（data/01-problem.csv など） */
  data?: string;
}

/**
 * 骨子（slides.md）。AI と人が読み、正式な提案資料の素材にする。式や SD の用語は使わない（スライドと同じ決まり）。
 * files は、スライドの番号（0 から）ごとの画像と CSV の相対パス
 */
export function slidesMarkdown(data: ModelResponse, deck: SlideDeck, options: { exportedAt: Date; pdf: string; files: SlideFiles[] }): string {
  const unit = unitOf(data);
  const time = (t: number) => `${formatTime(t)} ${unit}`.trim();
  const out: string[] = [];
  out.push(`# ${inline(deck.title || data.model.name || data.name)}`, "");
  out.push(`- モデル：${data.model.name && data.model.name !== data.name ? `${data.model.name}（${data.name}）` : data.name}`);
  out.push(`- 書き出した日時：${dateTime(options.exportedAt)}`);
  if (unit) out.push(`- 時間の単位：${unit}`);
  out.push(`- PDF：[${options.pdf}](${options.pdf})`);
  if (!data.run) out.push("- モデルにエラーがあるため、グラフの値はありません。");
  out.push("");

  deck.slides.forEach((slide, i) => {
    const files = options.files[i] ?? {};
    out.push(`## ${i + 1}. ${SLIDE_KIND_LABEL[slide.kind]}：${inline(slide.title)}`, "");
    out.push(`言いたいこと：${inline(slide.message)}`, "");
    const items: string[] = [];
    const after: string[] = [];
    switch (slide.kind) {
      case "problem":
        items.push(`注目する要素：${slide.elements.join("、")}`);
        if (slide.now !== undefined) items.push(`「今」の時点：${time(slide.now)}`);
        {
          const shown = slide.elements.filter((n) => {
            const name = elementName(data, n);
            return name && data.actual?.series[name]?.some((v) => v != null) && (slide.data ? slide.data.some((d) => sameName(d, name)) : true);
          });
          items.push(`重ねた実際のデータ：${shown.length ? shown.join("、") : "なし"}`);
        }
        break;
      case "cause": {
        const names = slide.loop.elements;
        items.push(`ループ：${names.length ? [...names, names[0]].join(" → ") : "—"}`);
        items.push(`ループの種類：${LOOP_KIND_LABEL[slide.loop.polarity]}（${slide.loop.polarity}）`);
        break;
      }
      case "solution": {
        const scenario = data.scenarios?.find((s) => sameName(s.name, slide.scenario));
        items.push(`シナリオ：${scenario?.name ?? slide.scenario}`);
        if (scenario?.description) items.push(`説明：${scenario.description}`);
        const changes = Object.entries(scenario?.values ?? {});
        if (changes.length) {
          after.push(
            "変える値：",
            "",
            ...table(
              ["変えるもの", "元の値", "このシナリオの値"],
              changes.map(([name, value]) => {
                const el = data.model.elements.find((e) => e.name && sameName(e.name, name));
                const before = el?.type === "STOCK" ? el.behavior?.initial_value : el?.behavior?.value;
                return [name, showEquation(before), showEquation(value)];
              }),
            ),
            "",
          );
        }
        break;
      }
      case "compare": {
        items.push(`比べるシナリオ：${[BASELINE_SCENARIO, ...slide.scenarios].join("、")}`);
        const run = data.run;
        if (run) {
          const at = slide.at ?? run.times.at(-1)!;
          items.push(`注目する時点：${time(at)}`);
          const runs = compareRuns(data, slide);
          const rows = slide.elements.flatMap((raw) => {
            const n = elementName(data, raw);
            if (!n || !run.series[n]) return [];
            const base = valueAt(run.times, run.series[n], at);
            return [
              [
                n,
                ...runs.map((r) => {
                  if (r.note) return r.note;
                  const v = r.series ? valueAt(run.times, r.series[n], at) : null;
                  const change = r.baseline ? "" : changeFrom(base, v);
                  return change ? `${formatReadable(v)}（${change}）` : formatReadable(v);
                }),
              ],
            ];
          });
          if (rows.length) after.push(`${time(at)}の値（かっこの中は「${BASELINE_SCENARIO}」と比べた変化）：`, "", ...table(["要素", ...runs.map((r) => r.name)], rows), "");
        } else if (slide.at !== undefined) items.push(`注目する時点：${time(slide.at)}`);
        break;
      }
      case "conclusion":
        break;
    }
    if (files.image) items.push(`画像：[${files.image}](${files.image})`);
    if (files.data) items.push(`グラフの値（CSV）：[${files.data}](${files.data})`);
    if (items.length) out.push(...items.map((s) => `- ${s}`), "");
    out.push(...after);
    if (files.image) out.push(`![${inline(slide.title)}](${files.image})`, "");
  });
  return out.join("\n").replace(/\n+$/, "") + "\n";
}
