import { loadModelJSON, type Model } from "simulation";
import type { ModelElement, ModelJSON } from "./modeljson.js";
import { ELEMENT_TYPES, canReference, didYouMean, engineModel, equationsOf, findElement, isConnector, nameKey, referencesIn, sameName } from "./modeljson.js";

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

function elementNames(model: ModelJSON): string[] {
  return model.elements.filter((e) => e.type !== "LINK" && e.name).map((e) => e.name!);
}

const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * 式の括弧の対応を確かめる。問題があれば説明の文を返す。
 * 文字列（"…" '…'）とコメント（# …、// …、/* … *\/）の中は見ない。[名前] の中も名前として扱う。
 */
export function checkBrackets(text: string): string | undefined {
  const stack: { ch: string; pos: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return ` ${c} で始まる文字列が閉じていません。`;
      i = end;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === "[") {
      const end = text.indexOf("]", i + 1);
      if (end < 0) return ` [ を閉じる ] がありません（${i + 1} 文字目）。`;
      i = end;
    } else if (c === "(" || c === "{") {
      stack.push({ ch: c, pos: i });
    } else if (c === ")" || c === "}" || c === "]") {
      const open = stack.pop();
      if (!open) return ` 対応する開き括弧のない ${c} があります（${i + 1} 文字目）。`;
      if (CLOSE_OF[open.ch] !== c) return ` ${open.ch}（${open.pos + 1} 文字目）を ${c} で閉じています。${CLOSE_OF[open.ch]} で閉じてください。`;
    }
  }
  if (stack.length) {
    const counts = new Map<string, number>();
    for (const s of stack) counts.set(s.ch, (counts.get(s.ch) ?? 0) + 1);
    return " " + [...counts].map(([ch, n]) => `${ch} を閉じる ${CLOSE_OF[ch]} が ${n} つ足りません。`).join("");
  }
  return undefined;
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
          const issue: Issue = { element: el.name ?? undefined, message: `${label(el)} の ${end} にある "${target}" が見つかりません。` };
          const guess = didYouMean(target, elementNames(model));
          if (guess) issue.hint = guess;
          errors.push(issue);
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
      const bracket = checkBrackets(eq.text);
      if (bracket) {
        errors.push({ element: el.name, message: `${label(el)} の式「${eq.text}」で${bracket}`, hint: "括弧 ( ) [ ] { } の対応を確かめてください。" });
        continue;
      }
      for (const ref of referencesIn(eq.text)) {
        const target = findElement(model, ref);
        if (!target) {
          errors.push({
            element: el.name,
            message: `${label(el)} の式が [${ref}] を参照していますが、その名前の要素がありません。`,
            hint: didYouMean(ref, elementNames(model)) || "名前の綴りを確かめるか、その要素を追加してください。",
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

  const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && !v.trim());
  const empty = model.elements.filter((e) => (e.type === "VARIABLE" || e.type === "FLOW") && e.name && isEmpty(e.behavior?.value)).map((e) => e.name!);
  if (empty.length) {
    const noStocks = !model.elements.some((e) => e.type === "STOCK");
    const allEmpty = model.elements.filter((e) => e.type === "VARIABLE" || e.type === "FLOW").length === empty.length;
    warnings.push(
      noStocks && allEmpty
        ? {
            message: `式のある要素がありません（${empty.join(", ")}）。因果ループ図（CLD）として描かれたモデルのようです。実行しても結果はすべて 0 になります。`,
            hint: "シミュレーションするなら、ストックとフローを足し、変数に式を入れてください。",
          }
        : { message: `式のない要素があります: ${empty.join(", ")}。値は 0 として扱われます。`, hint: "behavior.value に式か数を入れてください。" },
    );
  }

  const sim = model.simulation ?? {};
  if (sim.time_step !== undefined && sim.time_length !== undefined && sim.time_step > 0 && sim.time_length / sim.time_step > 100_000) {
    warnings.push({ message: `刻み数が ${Math.round(sim.time_length / sim.time_step)} あり、実行に時間がかかります。`, hint: "time_step を大きくするか time_length を短くしてください。" });
  }
  return { errors, warnings };
}

/** ModelJSON から実行用の Model を作る。失敗したら ModelError を投げる。Loopsight 独自の項目（強調、遅れの印など）は外して渡す（engineModel） */
export function buildModel(model: ModelJSON): Model {
  try {
    return loadModelJSON(engineModel(model));
  } catch (e) {
    throw toModelError(e);
  }
}

/** よく出るエンジンの英語のメッセージを日本語にする。知らないものはそのまま返す。 */
export function translateEngineMessage(message: string): string {
  // 「The primitive [X] has an equation error ...」の前置きは、要素名が別に付くので省く
  const body = message.replace(/^The primitive \[[^\]]*\] has an equation error that must be corrected before the model can be run\.\s*/, "");
  let m = /^Invalid equation syntax at "(.*)"\.?$/s.exec(body);
  if (m) return `式の文法が正しくありません（"${m[1]}" のあたり）。`;
  m = /^The variable or function "(.+)" does not exist\.?$/s.exec(body);
  if (m) return `変数か関数 "${m[1]}" がありません。`;
  return body;
}

export function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  const err = e as Error & { errors?: string[]; primitive?: { name?: string }; line?: number };
  if (Array.isArray(err.errors)) {
    const issues = err.errors.map((m) => ({ message: m }));
    return new ModelError("ModelJSON の読み込みでエラーが出ました。", issues);
  }
  const name = err.primitive?.name;
  const message = translateEngineMessage(String(err.message ?? err).trim());
  const issue: Issue = { element: name, message: err.line ? `${message}（式の ${err.line} 行目）` : message };
  const unknownFn = /変数か関数 "(.+)" がありません/.exec(message);
  if (unknownFn) {
    issue.hint = `関数名の綴りを確かめてください（大文字小文字も区別します）。要素を参照するなら [${unknownFn[1]}] のように角括弧で囲みます。`;
  } else if (/could not be found/.test(message)) {
    // 存在しない要素は実行前の確認で見つかるので、ここに来るのはリンクがない場合
    issue.hint = "参照している要素から、この要素へのリンクがあるか確かめてください。";
  } else if (/式の文法|equation error|syntax/i.test(message)) {
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
