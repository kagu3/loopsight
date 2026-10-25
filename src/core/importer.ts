import { unsupportedElementsMessage, type ModelJSON } from "./modeljson.js";

export class ImportError extends Error {
  override name = "ImportError";
}

export interface ImportResult {
  model: ModelJSON;
  /** 取り込めなかったもの、変換で失われたものの説明 */
  warnings: string[];
}

/** ファイルの中身を ModelJSON として取り込む */
export function importModelText(text: string, fallbackName?: string): ImportResult {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("{")) return importModelJSONText(trimmed, fallbackName);
  throw new ImportError("ModelJSON（{ で始まる JSON）ではありません。");
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
  const unsupported = unsupportedElementsMessage(json.elements);
  if (unsupported) throw new ImportError(unsupported);
  if (!json.name && fallbackName) json.name = fallbackName;
  return { model: json, warnings: [] };
}
