import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ModelJSON } from "./modeljson.js";
import { renameDataHeader } from "./data.js";
import { parseSlides, renameInSlides, type SlideDeck } from "./slides.js";

export class StoreError extends Error {
  override name = "StoreError";
}

/**
 * 作業フォルダの決め方：引数 > 環境変数 SD_MODELER_MODELS_DIR > ./models
 * 前の名前（insight-maker-mcp）のころの INSIGHT_MAKER_MODELS_DIR も、設定を書き換えなくて済むように読む。
 */
export function resolveModelsDir(explicit?: string): string {
  const dir = explicit || process.env.SD_MODELER_MODELS_DIR || process.env.INSIGHT_MAKER_MODELS_DIR || "models";
  return path.resolve(dir);
}

/**
 * モデル名をファイル名として使えるか確かめる。
 * パス区切りや「..」を拒否し、作業フォルダの外に書けないようにする。
 */
export function checkModelName(name: string): string {
  const n = name.trim();
  if (!n) throw new StoreError("モデル名が空です。");
  if (n.length > 100) throw new StoreError("モデル名は 100 文字以内にしてください。");
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n) || n === "." || n === ".." || n.startsWith(".")) {
    throw new StoreError(`モデル名 "${name}" には使えない文字が含まれています（/ \\ : * ? " < > | と先頭の . は使えません）。`);
  }
  const base = n.replace(/\.json$/i, "");
  // <モデル名>.slides.json は筋書きのファイルなので、モデルの名前には使わせない
  if (/\.slides$/i.test(base)) throw new StoreError(`モデル名 "${name}" は使えません（終わりの .slides は筋書きのファイルに使います）。`);
  return base;
}

/** ファイルの中身から版を作る（中身が同じなら同じ版） */
export function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface ModelInfo {
  name: string;
  file: string;
  title?: string;
  elements: number;
  modified: string;
}

/** 作業フォルダの ModelJSON ファイルを読み書きする */
export class ModelStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  pathOf(name: string): string {
    return path.join(this.dir, `${checkModelName(name)}.json`);
  }

  /** 実際のデータのファイル（<モデル名>.data.csv）。モデルの一覧には出さない */
  dataPathOf(name: string): string {
    return path.join(this.dir, `${checkModelName(name)}.data.csv`);
  }

  /** 実際のデータの CSV を読む。なければ undefined */
  async readData(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.dataPathOf(name), "utf8");
    } catch {
      return undefined;
    }
  }

  /** 実際のデータを書く。BOM を付けて、Excel でも日本語の要素名が文字化けしないようにする */
  async writeData(name: string, csv: string): Promise<string> {
    return this.writeTextFile(this.dataPathOf(name), "﻿" + csv);
  }

  /**
   * 要素の名前を変えたときに、実際のデータの列名も直す。例外は投げず、知らせる文を返す。
   * 直したら note、直せなかったら warning（モデルはもう保存してあるので、編集は失敗にしない）。
   * データがないときや、合う列がないときは何も返さない
   */
  async renameDataColumns(name: string, renames: [string, string][]): Promise<{ note?: string; warning?: string }> {
    if (!renames.length) return {};
    const text = await this.readData(name);
    if (text === undefined) return {};
    const file = path.basename(this.dataPathOf(name));
    try {
      const next = renameDataHeader(text, renames);
      if (next === undefined) return {};
      await this.writeTextFile(this.dataPathOf(name), next);
      return { note: `実際のデータ（${file}）の列名も直しました。` };
    } catch (e) {
      return {
        warning:
          `実際のデータ（${file}）の列名を直せませんでした（${(e as Error).message}）。` +
          "ファイルがほかのアプリ（Excel など）で開かれていないか確かめ、列名を要素名にそろえてください。",
      };
    }
  }

  /** 会議資料の筋書きのファイル（<モデル名>.slides.json）。モデルの一覧には出さない */
  slidesPathOf(name: string): string {
    return path.join(this.dir, `${checkModelName(name)}.slides.json`);
  }

  /** 筋書きのファイルの中身と版を読む。なければ undefined。版はモデルとは別に持つ */
  async readSlidesText(name: string): Promise<{ text: string; version: string } | undefined> {
    try {
      const text = await readFile(this.slidesPathOf(name), "utf8");
      return { text, version: versionOf(text) };
    } catch {
      return undefined;
    }
  }

  /** 筋書きを書いて、ファイルと版を返す */
  async writeSlides(name: string, deck: SlideDeck): Promise<{ file: string; version: string }> {
    const text = JSON.stringify(deck, null, 2) + "\n";
    const file = await this.writeTextFile(this.slidesPathOf(name), text);
    return { file, version: versionOf(text) };
  }

  /**
   * 要素や施策の名前を変えたときに、筋書きの中の名前も直す。例外は投げず、知らせる文を返す（renameDataColumns と同じ）。
   * 筋書きがないときや、合う名前がないときは何も返さない
   */
  async renameSlideNames(name: string, renames: { elements?: [string, string][]; scenarios?: [string, string][] }): Promise<{ note?: string; warning?: string }> {
    if (!renames.elements?.length && !renames.scenarios?.length) return {};
    const current = await this.readSlidesText(name);
    if (current === undefined) return {};
    const file = path.basename(this.slidesPathOf(name));
    try {
      const deck = parseSlides(current.text);
      if (!renameInSlides(deck, renames)) return {};
      await this.writeSlides(name, deck);
      return { note: `筋書き（${file}）の中の名前も直しました。` };
    } catch (e) {
      return {
        warning: `筋書き（${file}）の中の名前を直せませんでした（${(e as Error).message}）。set_slides で筋書きを保存し直してください。`,
      };
    }
  }

  /** 作業フォルダ内の相対パスを絶対パスにする。フォルダの外を指していたら拒否する。 */
  resolveInside(relative: string): string {
    const p = path.resolve(this.dir, relative);
    const rel = path.relative(this.dir, p);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new StoreError(`"${relative}" は作業フォルダ（${this.dir}）の外を指しています。`);
    }
    return p;
  }

  async exists(name: string): Promise<boolean> {
    try {
      await stat(this.pathOf(name));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<ModelInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: ModelInfo[] = [];
    // 筋書き（<モデル名>.slides.json）はモデルではないので出さない
    for (const file of files.filter((f) => f.toLowerCase().endsWith(".json") && !f.toLowerCase().endsWith(".slides.json")).sort()) {
      const full = path.join(this.dir, file);
      try {
        const [text, st] = await Promise.all([readFile(full, "utf8"), stat(full)]);
        const json = JSON.parse(text) as Partial<ModelJSON>;
        out.push({
          name: file.replace(/\.json$/i, ""),
          file: full,
          title: typeof json.name === "string" ? json.name : undefined,
          elements: Array.isArray(json.elements) ? json.elements.length : 0,
          modified: st.mtime.toISOString(),
        });
      } catch {
        // ModelJSON でないファイルは一覧に出さない
      }
    }
    return out;
  }

  async read(name: string): Promise<ModelJSON> {
    return (await this.readVersioned(name)).model;
  }

  /**
   * モデルと、その版（ファイルの中身のハッシュ）を読む。
   * 版は、読んでから書くまでのあいだにほかから変えられていないかを確かめるのに使う。
   */
  async readVersioned(name: string): Promise<{ model: ModelJSON; version: string; text: string }> {
    const file = this.pathOf(name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      const names = (await this.list()).map((m) => m.name);
      throw new StoreError(
        `モデル "${name}" が見つかりません。` + (names.length ? `あるモデル: ${names.join(", ")}` : "作業フォルダにモデルがありません。"),
      );
    }
    try {
      const json = JSON.parse(text) as ModelJSON;
      if (!json || typeof json !== "object" || !Array.isArray(json.elements)) {
        throw new Error("elements 配列がありません");
      }
      return { model: json, version: versionOf(text), text };
    } catch (e) {
      throw new StoreError(`${file} を ModelJSON として読めません: ${(e as Error).message}`);
    }
  }

  async write(name: string, model: ModelJSON): Promise<string> {
    return this.writeJSONFile(this.pathOf(name), model);
  }

  /** 書いて、書いた中身の版を返す。text を渡すと、その中身をそのまま書く */
  async writeVersioned(name: string, model: ModelJSON | { text: string }): Promise<string> {
    const text = "text" in model && typeof model.text === "string" ? model.text : JSON.stringify(model, null, 2) + "\n";
    await this.writeTextFile(this.pathOf(name), text);
    return versionOf(text);
  }

  async remove(name: string): Promise<void> {
    await unlink(this.pathOf(name));
  }

  /** 一時ファイルに書いてから置き換える（途中で止まっても壊れたファイルを残さない） */
  async writeJSONFile(file: string, data: unknown): Promise<string> {
    return this.writeTextFile(file, JSON.stringify(data, null, 2) + "\n");
  }

  async writeTextFile(file: string, text: string): Promise<string> {
    return this.writeBinaryFile(file, Buffer.from(text, "utf8"));
  }

  /** 一時ファイルに書いてから置き換える。書けなかったら一時ファイルを消す */
  async writeBinaryFile(file: string, data: Uint8Array): Promise<string> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
    return file;
  }
}
