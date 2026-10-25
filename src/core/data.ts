import type { ModelElement, ModelJSON } from "./modeljson.js";
import { didYouMean, findElement, nameKey } from "./modeljson.js";
import { ImportError } from "./importer.js";
import type { Issue } from "./validate.js";

// 実際のデータ（<モデル名>.data.csv）。モデルの線と見比べるために、グラフに点で重ねる。
// エンジンは ModelJSON の決まったキー以外を受け付けないので、モデルのファイルには入れず、別のファイルに置く。
// 1 列目が時刻、ほかの列が要素名。Excel から貼れるように CSV にする（タブ区切りも読む）。

export interface ActualData {
  /** 1 列目（時刻）の見出し */
  time_label: string;
  times: number[];
  /** 列ごとの値（空欄は null）。並びは CSV のまま */
  columns: { name: string; values: (number | null)[] }[];
}

/** CSV の 1 行を区切る。"…" で囲んだ値の中の区切りと改行、"" は文字として扱う */
function splitRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // 空の行（Excel が末尾に付ける区切りだけの行も）は読み飛ばす
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** 数にする。Excel の桁区切り（1,234）も読む。空欄は null、読めなければ undefined */
function parseNumber(s: string): number | null | undefined {
  const t = s.trim().replace(/^(-?)[\d,]+(\.\d*)?$/, (m) => m.replace(/,/g, ""));
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** 区切り文字。1 行目にタブがあってカンマがなければタブ区切り（Excel から貼ったもの） */
function separatorOf(body: string): string {
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  return first.includes("\t") && !first.includes(",") ? "\t" : ",";
}

/** CSV（タブ区切りでもよい）を読む。形が違えば ImportError */
export function parseDataCSV(text: string): ActualData {
  const body = text.replace(/^﻿/, "");
  const sep = separatorOf(body);
  const rows = splitRows(body, sep);
  if (rows.length === 0) throw new ImportError("CSV が空です。1 行目に見出し（1 列目は時刻、ほかの列は要素名）を書いてください。");
  const header = rows[0]!.map((h) => h.trim());
  // 見出しも値もない列（Excel が右端に付ける空の列）は外す
  const used = header.map((h, j) => j === 0 || h !== "" || rows.some((r) => (r[j] ?? "").trim() !== ""));
  const names = header.slice(1).filter((_, j) => used[j + 1]);
  if (names.length === 0) throw new ImportError("要素の列がありません。1 列目に時刻、2 列目から要素の値を並べてください。");
  const seen = new Set<string>();
  header.forEach((h, j) => {
    if (j === 0 || !used[j]) return;
    if (h === "") throw new ImportError(`${j + 1} 列目の見出し（要素名）が空です。`);
    if (seen.has(nameKey(h))) throw new ImportError(`列 "${h}" が 2 つあります。`);
    seen.add(nameKey(h));
  });

  const points: { t: number; values: (number | null)[] }[] = [];
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const t = parseNumber(r[0] ?? "");
    if (t === null || t === undefined) throw new ImportError(`${line} 行目の時刻 "${r[0] ?? ""}" を数として読めません。1 列目は時刻（数）にしてください。`);
    const values: (number | null)[] = [];
    header.forEach((h, j) => {
      if (j === 0 || !used[j]) return;
      const v = parseNumber(r[j] ?? "");
      if (v === undefined) throw new ImportError(`${line} 行目の "${h}" の値 "${r[j]}" を数として読めません。`);
      values.push(v);
    });
    points.push({ t, values });
  });
  points.sort((a, b) => a.t - b.t);
  return {
    time_label: header[0] || "Time",
    times: points.map((p) => p.t),
    columns: names.map((name, j) => ({ name, values: points.map((p) => p.values[j]!) })),
  };
}

function csvField(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV にする（1 列目が時刻） */
export function dataToCSV(data: ActualData): string {
  const lines = [[data.time_label, ...data.columns.map((c) => c.name)].map(csvField).join(",")];
  data.times.forEach((t, i) => lines.push([t, ...data.columns.map((c) => c.values[i] ?? null)].map(csvField).join(",")));
  return lines.join("\n") + "\n";
}

/**
 * 実際のデータがモデルに合うか確かめる。列名が要素名と合うか（合う列は要素の表記にそろえる）と、
 * 時刻がシミュレーションの期間と重なるか（重ならなければグラフに点が出ない）
 */
export function checkActualData(model: ModelJSON, data: ActualData): Issue[] {
  const names = model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
  const issues: Issue[] = [];
  for (const c of data.columns) {
    const el = findElement(model, c.name);
    if (el) {
      c.name = el.name!;
      continue;
    }
    issues.push({
      message: `実際のデータの列 "${c.name}" に合う要素がありません。`,
      hint: didYouMean(c.name, names) || "列名を要素名にそろえてください（大文字と小文字は区別しません）。",
    });
  }
  const start = model.simulation?.time_start ?? 0;
  const end = start + (model.simulation?.time_length ?? 0);
  if (data.times.length && data.times.every((t) => t < start || t > end)) {
    issues.push({
      message: `実際のデータの時刻（${data.times[0]} から ${data.times.at(-1)}）が、シミュレーションの期間（${start} から ${end}）と重なりません。`,
      hint: "時刻の数え方（年の数え始めなど）をモデルにそろえるか、期間を変えてください（AI は set_simulation、ビューアはグラフの上の帯の期間のボタン ⏱）。",
    });
  }
  return issues;
}

/** 要素 → いまの名前。名前を変えたかどうかを、あとで renamesSince で調べるために取っておく */
export function namesByElement(model: ModelJSON): Map<ModelElement, string> {
  return new Map(model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => [e, e.name!]));
}

/** namesByElement を取ってから名前の変わった要素の [前の名前, 新しい名前] */
export function renamesSince(model: ModelJSON, before: Map<ModelElement, string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [el, name] of before) {
    if (model.elements.includes(el) && el.name && el.name !== name) out.push([name, el.name]);
  }
  return out;
}

/**
 * CSV の見出しの列名を変える（要素の名前を変えたとき）。変えた CSV を返し、合う列がなければ undefined。
 * 見出しの行だけを書き換え、ほかの行は元の文字のまま残す（値の表記や行の順を変えないため）。
 * 見出しが読めないときや、変えると列名が重なるときは ImportError
 */
export function renameDataHeader(text: string, renames: [string, string][]): string | undefined {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const body = text.slice(bom.length);
  const sep = separatorOf(body);
  // 見出しは、空でない最初の行
  for (const m of body.matchAll(/[^\r\n]*/g)) {
    const line = m[0];
    const cells = splitRows(line, sep)[0];
    if (!cells) continue;
    if ((line.match(/"/g) ?? []).length % 2 !== 0) throw new ImportError("見出しの行が読めません（\" が閉じていません）。");
    let changed = false;
    const next = cells.map((cell, j) => {
      if (j === 0) return cell;
      const r = renames.find(([from]) => nameKey(from) === nameKey(cell));
      if (!r || cell.trim() === r[1]) return cell;
      changed = true;
      return r[1];
    });
    if (!changed) return undefined;
    const seen = new Set<string>();
    for (const n of next.slice(1).map((c) => c.trim()).filter((c) => c !== "")) {
      if (seen.has(nameKey(n))) throw new ImportError(`変えると、列 "${n}" が 2 つになります。`);
      seen.add(nameKey(n));
    }
    const field = (s: string) => (s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return bom + body.slice(0, m.index) + next.map(field).join(sep) + body.slice(m.index + line.length);
  }
  throw new ImportError("見出しの行がありません。");
}
