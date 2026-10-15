import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ModelJSON } from "./modeljson.js";

export class StoreError extends Error {
  override name = "StoreError";
}

/** 作業フォルダの決め方：引数 > 環境変数 INSIGHT_MAKER_MODELS_DIR > ./models */
export function resolveModelsDir(explicit?: string): string {
  const dir = explicit || process.env.INSIGHT_MAKER_MODELS_DIR || "models";
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
  return n.replace(/\.json$/i, "");
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
    for (const file of files.filter((f) => f.toLowerCase().endsWith(".json")).sort()) {
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
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
    return file;
  }
}
