import { loadModelJSON, type Model } from "simulation";
import type { ModelElement, ModelJSON } from "./modeljson.js";
import { ELEMENT_TYPES, equationsOf, findElement, isConnector, nameKey, referencesIn, sameName } from "./modeljson.js";

export interface Issue {
  /** 問題のある要素の名前（わかる場合） */
  element?: string;
  message: string;
  /** どう直せばよいか */
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** エンジンが出したエラーを、AI が読める形にして持つ */
export class ModelError extends Error {
  override name = "ModelError";
  constructor(
    message: string,
    readonly issues: Issue[],
  ) {
    super(message);
  }
}

function label(el: ModelElement): string {
  return el.name ? `${el.type} "${el.name}"` : `${el.type}（${el.from ?? "?"} → ${el.to ?? "?"}）`;
}

/** エンジンを動かさずにわかる問題を探す */
export function staticCheck(model: ModelJSON): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const seen = new Map<string, ModelElement>();

  for (const el of model.elements) {
    if (!ELEMENT_TYPES.includes(el.type)) {
      errors.push({ element: el.name, message: `不明な要素の種類 "${String(el.type)}"。`, hint: `種類は ${ELEMENT_TYPES.join(", ")} のどれかです。` });
      continue;
    }
    if (el.type !== "LINK") {
      if (!el.name?.trim()) {
        errors.push({ message: `名前のない ${el.type} があります。`, hint: "LINK 以外の要素には名前が必要です。" });
        continue;
      }
      const key = nameKey(el.name);
      if (seen.has(key)) {
        errors.push({ element: el.name, message: `名前 "${el.name}" が重複しています（大文字小文字は区別しません）。`, hint: "どちらかの名前を変えてください。" });
      }
      seen.set(key, el);
    }
  }

  for (const el of model.elements) {
    if (isConnector(el.type)) {
      for (const end of ["from", "to"] as const) {
        const target = el[end];
        if (target && !findElement(model, target)) {
          errors.push({ element: el.name ?? undefined, message: `${label(el)} の ${end} にある "${target}" が見つかりません。` });
        }
      }
      if (el.type === "FLOW") {
        for (const end of ["from", "to"] as const) {
          const target = el[end] ? findElement(model, el[end]!) : undefined;
          if (target && target.type !== "STOCK") {
            errors.push({ element: el.name, message: `FLOW "${el.name}" の ${end} が ${target.type} "${target.name}" になっています。`, hint: "フローはストックどうし（または空＝モデルの外）をつなぎます。" });
          }
        }
      }
    }

    for (const eq of equationsOf(el)) {
      for (const ref of referencesIn(eq.text)) {
        const target = findElement(model, ref);
        if (!target) {
          errors.push({
            element: el.name,
            message: `${label(el)} の式が [${ref}] を参照していますが、その名前の要素がありません。`,
            hint: "名前の綴りを確かめるか、その要素を追加してください。",
          });
          continue;
        }
        if (!canReference(model, el, ref)) {
          errors.push({
            element: el.name,
            message: `${label(el)} の式が [${ref}] を参照していますが、"${target.name}" から "${el.name}" へのリンクがありません。`,
            hint: `LINK（from: "${target.name}", to: "${el.name}"）を追加してください。upsert_elements は既定でリンクを自動で追加します。`,
          });
        }
      }
    }

    if (el.type === "CONVERTER") {
      const b = el.behavior ?? {};
      if (b.input === "ELEMENT" && !b.input_element) {
        errors.push({ element: el.name, message: `CONVERTER "${el.name}" の入力が ELEMENT ですが input_element がありません。` });
      }
      if (!Array.isArray(b.data) || b.data.length === 0) {
        warnings.push({ element: el.name, message: `CONVERTER "${el.name}" にデータ点がありません。`, hint: "behavior.data に [[入力, 出力], ...] を入れてください。" });
      }
    }
  }

  const sim = model.simulation ?? {};
  if (sim.time_step !== undefined && sim.time_length !== undefined && sim.time_step > 0 && sim.time_length / sim.time_step > 100_000) {
    warnings.push({ message: `刻み数が ${Math.round(sim.time_length / sim.time_step)} あり、実行に時間がかかります。`, hint: "time_step を大きくするか time_length を短くしてください。" });
  }
  return { errors, warnings };
}

/** el の式が ref を参照してよいか（リンクがあるか、フローが自分のストックを見ているか） */
export function canReference(model: ModelJSON, el: ModelElement, ref: string): boolean {
  if (el.name && sameName(el.name, ref)) return true;
  if ((el.type === "FLOW" || el.type === "TRANSITION") && (sameName(el.from, ref) || sameName(el.to, ref))) return true;
  return model.elements.some((l) => l.type === "LINK" && sameName(l.from, ref) && sameName(l.to, el.name));
}

/** ModelJSON から実行用の Model を作る。失敗したら ModelError を投げる。 */
export function buildModel(model: ModelJSON): Model {
  try {
    return loadModelJSON(model);
  } catch (e) {
    throw toModelError(e);
  }
}

export function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const err = e as Error & { errors?: string[]; primitive?: { name?: string }; line?: number };
  if (Array.isArray(err.errors)) {
    const issues = err.errors.map((m) => ({ message: m }));
    return new ModelError("ModelJSON の読み込みでエラーが出ました。", issues);
  }
  const name = err.primitive?.name;
  const message = String(err.message ?? err).trim();
  const issue: Issue = { element: name, message: err.line ? `${message}（式の ${err.line} 行目）` : message };
  if (/could not be found/.test(message)) {
    issue.hint = "参照している要素から、この要素へのリンクがあるか確かめてください。";
  } else if (/equation error|syntax/i.test(message)) {
    issue.hint = "式の書き方を確かめてください。要素の参照は [名前]、単位つきの数は {5 Meters} のように書きます。";
  } else if (/unit/i.test(message)) {
    issue.hint = "単位が合っているか確かめてください（behavior.units と式の単位）。";
  }
  return new ModelError(name ? `"${name}" でエラーが出ました。` : "モデルの実行でエラーが出ました。", [issue]);
}

/**
 * モデルを検証する。静的な確認のあと、エンジンで読み込み、必要なら試しに実行する。
 */
export function validateModel(model: ModelJSON, options: { trialRun?: boolean } = {}): ValidationResult {
  const { errors, warnings } = staticCheck(model);
  if (errors.length === 0) {
    try {
      const m = buildModel(model);
      if (options.trialRun !== false) m.simulate();
    } catch (e) {
      errors.push(...toModelError(e).issues);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
