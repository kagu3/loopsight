import { loadInsightMaker, toModelJSON } from "simulation";
import type { ModelElement, ModelJSON, Point } from "./modeljson.js";
import { nameKey } from "./modeljson.js";

export class ImportError extends Error {
  override name = "ImportError";
}

export interface ImportResult {
  model: ModelJSON;
  /** 取り込めなかったもの、変換で失われたものの説明 */
  warnings: string[];
}

/** ファイルの中身から形式を判断して取り込む */
export function importModelText(text: string, fallbackName?: string): ImportResult {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("{")) return importModelJSONText(trimmed, fallbackName);
  if (trimmed.startsWith("<")) return importInsightMakerXML(trimmed, fallbackName);
  throw new ImportError("ModelJSON（{ で始まる JSON）でも Insight Maker の XML（< で始まる）でもありません。");
}

export function importModelJSONText(text: string, fallbackName?: string): ImportResult {
  let json: ModelJSON;
  try {
    json = JSON.parse(text) as ModelJSON;
  } catch (e) {
    throw new ImportError(`JSON として読めません: ${(e as Error).message}`);
  }
  if (!json || typeof json !== "object" || !Array.isArray(json.elements)) {
    throw new ImportError("ModelJSON には elements 配列が必要です。");
  }
  if (!json.name && fallbackName) json.name = fallbackName;
  return { model: json, warnings: [] };
}

/**
 * Insight Maker の XML（.InsightMaker ファイル）を ModelJSON に変換する。
 * エンジンの読み込み処理は座標を読まないので、mxGeometry から自前で補う。
 */
export function importInsightMakerXML(xml: string, fallbackName?: string): ImportResult {
  const renamed = xml.replace(/<(\/?)mxGraphModel\b/g, "<$1InsightMakerModel");
  if (!renamed.includes("<InsightMakerModel")) {
    throw new ImportError("Insight Maker のモデル（<mxGraphModel> または <InsightMakerModel>）ではありません。");
  }

  let json: ModelJSON;
  try {
    json = toModelJSON(loadInsightMaker(renamed)) as unknown as ModelJSON;
  } catch (e) {
    throw new ImportError(`Insight Maker のモデルを変換できません: ${(e as Error).message}`);
  }

  const warnings: string[] = [];
  if (json.file_notes) {
    warnings.push(...json.file_notes.split("\n").filter(Boolean));
    delete json.file_notes;
  }
  warnings.push(...unsupportedContent(renamed));

  applyGeometry(json.elements, parseGeometry(renamed));
  if (!json.name && fallbackName) json.name = fallbackName;
  return { model: json, warnings };
}

interface Geometry {
  x: number;
  y: number;
  width?: number;
  height?: number;
  source?: Point;
  target?: Point;
}

interface XmlCell {
  tag: string;
  id?: string;
  name?: string;
  parent?: string;
  geometry?: Geometry;
}

const PRIMITIVE_TAGS = ["Stock", "Variable", "Converter", "State", "Flow", "Link", "Transition", "Folder", "Text", "Picture", "Button", "Action", "Agent", "Ghost", "Display", "Setting"];

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? "");
  }
  return out;
}

function num(v: string | undefined): number {
  const n = v === undefined ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseCells(xml: string): XmlCell[] {
  const cells: XmlCell[] = [];
  const re = new RegExp(`<(${PRIMITIVE_TAGS.join("|")})\\b([^>]*?)(/?)>`, "g");
  for (const m of xml.matchAll(re)) {
    const tag = m[1]!;
    const a = attrs(m[2]!);
    let body = "";
    if (m[3] !== "/") {
      const end = xml.indexOf(`</${tag}>`, m.index! + m[0].length);
      if (end >= 0) body = xml.slice(m.index! + m[0].length, end);
    }
    const cell: XmlCell = { tag, id: a.id, name: a.name };
    const mx = body.match(/<mxCell\b([^>]*)>/);
    if (mx) cell.parent = attrs(mx[1]!).parent;
    const g = body.match(/<mxGeometry\b([^>]*?)(\/?)>/);
    if (g) {
      const ga = attrs(g[1]!);
      const geom: Geometry = { x: num(ga.x), y: num(ga.y) };
      if (ga.width !== undefined) geom.width = num(ga.width);
      if (ga.height !== undefined) geom.height = num(ga.height);
      for (const p of body.matchAll(/<mxPoint\b([^>]*?)\/?>/g)) {
        const pa = attrs(p[1]!);
        if (pa.as === "sourcePoint") geom.source = [num(pa.x), num(pa.y)];
        if (pa.as === "targetPoint") geom.target = [num(pa.x), num(pa.y)];
      }
      cell.geometry = geom;
    }
    cells.push(cell);
  }
  return cells;
}

/** 名前 → 絶対座標（フォルダの中の要素はフォルダの位置を足す） */
function parseGeometry(xml: string): Map<string, Geometry> {
  const cells = parseCells(xml);
  const byId = new Map(cells.filter((c) => c.id).map((c) => [c.id!, c]));

  const offsetOf = (cell: XmlCell): [number, number] => {
    let dx = 0;
    let dy = 0;
    let p = cell.parent ? byId.get(cell.parent) : undefined;
    const seen = new Set<string>();
    while (p && p.geometry && p.id && !seen.has(p.id)) {
      seen.add(p.id);
      dx += p.geometry.x;
      dy += p.geometry.y;
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    return [dx, dy];
  };

  const out = new Map<string, Geometry>();
  for (const cell of cells) {
    if (!cell.name || !cell.geometry) continue;
    const [dx, dy] = offsetOf(cell);
    const g = cell.geometry;
    out.set(`${cell.tag}:${nameKey(cell.name)}`, {
      x: Math.round(g.x + dx),
      y: Math.round(g.y + dy),
      width: g.width,
      height: g.height,
      source: g.source && [Math.round(g.source[0] + dx), Math.round(g.source[1] + dy)],
      target: g.target && [Math.round(g.target[0] + dx), Math.round(g.target[1] + dy)],
    });
  }
  return out;
}

const TAG_OF: Record<string, string> = {
  STOCK: "Stock",
  VARIABLE: "Variable",
  CONVERTER: "Converter",
  STATE: "State",
  FLOW: "Flow",
  TRANSITION: "Transition",
};

function applyGeometry(elements: ModelElement[], geometry: Map<string, Geometry>): void {
  for (const el of elements) {
    const tag = TAG_OF[el.type];
    if (!tag || !el.name) continue;
    const g = geometry.get(`${tag}:${nameKey(el.name)}`);
    if (!g) continue;
    if (el.type === "FLOW" || el.type === "TRANSITION") {
      if (!el.from && g.source) (el.display ??= {}).from_coordinates = g.source;
      if (!el.to && g.target) (el.display ??= {}).to_coordinates = g.target;
    } else {
      el.display ??= {};
      el.display.coordinates = [g.x, g.y];
      if (g.width && g.height) el.display.size = [g.width, g.height];
    }
  }
}

/** ModelJSON に入らない内容を数えて警告にする */
function unsupportedContent(xml: string): string[] {
  const count = (re: RegExp) => [...xml.matchAll(re)].length;
  const notes: string[] = [];
  const items: [string, number][] = [
    ["エージェント（Agent / Population）", count(/<(Agent|Population)\b/g) + count(/<Folder\b[^>]*\bType="Agent"/g)],
    ["アクション（Action）", count(/<Action\b/g)],
    ["テキスト（Text）", count(/<Text\b/g)],
    ["画像（Picture）", count(/<Picture\b/g)],
    ["ボタン（Button）", count(/<Button\b/g)],
    ["フォルダ（Folder、中の要素は残る）", count(/<Folder\b/g)],
  ];
  for (const [label, n] of items) {
    if (n > 0) notes.push(`${label} が ${n} 個ありましたが、ModelJSON では表せないため取り込んでいません。`);
  }
  return notes;
}
