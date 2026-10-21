import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ModelJSON } from "./modeljson.js";
import { renameDataHeader } from "./data.js";
import { parseSlides, renameInSlides, type SlideDeck } from "./slides.js";

export class StoreError extends Error {
  override name = "StoreError";
}

/**
 * 作業フォルダの決め方：引数 > 環境変数 LOOPSIGHT_MODELS_DIR > ./models
 */
export function resolveModelsDir(explicit?: string): string {
  const dir = explicit || process.env.LOOPSIGHT_MODELS_DIR || "models";
  return path.resolve(dir);
}

/** 名前の 1 つ分（フォルダ名やファイル名）の長さの上限 */
const MAX_PART = 100;
/** フォルダを含めた名前全体の長さの上限 */
const MAX_PATH = 255;

/**
 * フォルダを含む名前（/ 区切り）を部分に分けて確かめる。
 * \ や「..」、絶対パス（先頭の / や C:）、先頭が . の部分（隠しフォルダなど）を拒否し、作業フォルダの外に書けないようにする。
 * フォルダの区切りは、どの OS でも / にそろえる（\ は使わせない）
 */
function checkParts(n: string, original: string, what: string): string[] {
  if (n.length > MAX_PATH) throw new StoreError(`${what}は、フォルダを含めて ${MAX_PATH} 文字以内にしてください。`);
  const parts = n.split("/");
  for (const part of parts) {
    if (!part) throw new StoreError(`${what} "${original}" に空の部分があります（先頭や終わりの /、続けた // は使えません）。`);
    if (part.length > MAX_PART) throw new StoreError(`${what}のフォルダ名やファイル名は、1 つ ${MAX_PART} 文字以内にしてください。`);
    if (/[\\:*?"<>|\x00-\x1f]/.test(part) || part.startsWith(".")) {
      throw new StoreError(`${what} "${original}" には使えない文字が含まれています（\\ : * ? " < > | と、先頭の . は使えません。フォルダの区切りは / にします）。`);
    }
    if (part !== part.trim()) throw new StoreError(`${what} "${original}" の、フォルダ名やファイル名の前後に空白があります。`);
    // Windows は終わりの . を落とすので、「t.」と「t」が同じフォルダになってしまう
    if (part.endsWith(".")) throw new StoreError(`${what} "${original}" の、フォルダ名やファイル名の終わりに . は使えません。`);
  }
  return parts;
}

/**
 * モデル名をファイル名として使えるか確かめ、そろえた名前（終わりの .json を外したもの）を返す。
 * モデル名は作業フォルダからの相対パス（/ 区切り、.json なし）。例：ブルックスの法則/brooks_law。直下のモデルはファイル名だけ
 */
export function checkModelName(name: string): string {
  const n = name.trim();
  if (!n) throw new StoreError("モデル名が空です。");
  const parts = checkParts(n.replace(/\.json$/i, ""), name, "モデル名");
  // <モデル名>.slides.json は筋書きのファイルなので、モデルの名前には使わせない
  if (/\.slides$/i.test(parts.at(-1)!)) throw new StoreError(`モデル名 "${name}" は使えません（終わりの .slides は筋書きのファイルに使います）。`);
  return parts.join("/");
}

/** フォルダ名（作業フォルダからの相対パス、/ 区切り）を確かめ、そろえた名前を返す。作業フォルダそのもの（空の名前）は指定できない */
export function checkFolderName(name: string): string {
  const n = name.trim().replace(/\/$/, "");
  if (!n) throw new StoreError("フォルダ名が空です（作業フォルダそのものは指定できません）。");
  return checkParts(n, name, "フォルダ名").join("/");
}

/** モデル名のうち、フォルダの部分（直下のモデルは ""） */
export function folderOf(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i);
}

// ファイル名の大文字と小文字は、区別しない Windows と macOS でだけ同じに扱う（ビューアの画面からの書き込みの記録と同じ）
const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const fileKey = (name: string) => (caseInsensitive ? name.toLowerCase() : name);

/** OS が勝手に作るファイル。フォルダが空かどうかを決めるときは数えない（空のフォルダを消すときは、いっしょに消す） */
const OS_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const isOSFile = (file: string) => OS_FILES.has(file.toLowerCase());

/** モデルのファイル（<モデル名>.json）か。筋書き（<モデル名>.slides.json）はモデルではない */
const isModelFile = (file: string) => file.toLowerCase().endsWith(".json") && !file.toLowerCase().endsWith(".slides.json");

/** エクスプローラーと同じように、大文字と小文字を区別せず、数字は数の大きさの順に並べる */
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
export const compareNames = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** ファイルの中身から版を作る（中身が同じなら同じ版） */
export function versionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface ModelInfo {
  /** モデル名（作業フォルダからの相対パス、/ 区切り、.json なし） */
  name: string;
  /** モデルのあるフォルダ（作業フォルダからの相対パス。直下なら ""） */
  folder: string;
  file: string;
  title?: string;
  elements: number;
  modified: string;
}

/** 一覧に出すフォルダ。中に（サブフォルダの中も含めて）モデルがあるフォルダと、空のフォルダ */
export interface FolderInfo {
  /** フォルダ名（作業フォルダからの相対パス、/ 区切り） */
  name: string;
  /** 中にあるモデルの数（サブフォルダの中も数える）。0 なら空のフォルダ */
  models: number;
}

/** 作業フォルダの中身（モデルとフォルダ）。モデルは名前順、フォルダは木をたどる順（親のすぐあとに子） */
export interface ModelTree {
  models: ModelInfo[];
  folders: FolderInfo[];
}

/** 動かしたり消したりできなかったときに添える文 */
const BUSY = "ファイルがほかのアプリ（Excel など）で開かれていないか確かめてから、もう一度試してください。";

/** ファイル（フォルダでないもの）があるか */
async function isFile(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined))?.isFile() ?? false;
}

/** ファイルかフォルダがあるか */
async function exists(file: string): Promise<boolean> {
  return (await stat(file).catch(() => undefined)) !== undefined;
}

/** 一覧に出すモデルの情報を読む。ModelJSON でないファイルは undefined */
async function readInfo(file: string, name: string, folder: string): Promise<ModelInfo | undefined> {
  try {
    const [text, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const json = JSON.parse(text) as Partial<ModelJSON>;
    return {
      name,
      folder,
      file,
      title: typeof json.name === "string" ? json.name : undefined,
      elements: Array.isArray(json.elements) ? json.elements.length : 0,
      modified: st.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
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

  /** 説明資料の筋書きのファイル（<モデル名>.slides.json）。モデルの一覧には出さない */
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
   * 要素やシナリオの名前を変えたときに、筋書きの中の名前も直す。例外は投げず、知らせる文を返す（renameDataColumns と同じ）。
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
    // 「..」で始まる名前のフォルダ（..foo など）は外ではないので、区切りまで見る
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new StoreError(`"${relative}" は作業フォルダ（${this.dir}）の外を指しています。`);
    }
    return p;
  }

  /** フォルダの絶対パス */
  folderPathOf(name: string): string {
    return path.join(this.dir, checkFolderName(name));
  }

  async exists(name: string): Promise<boolean> {
    return isFile(this.pathOf(name));
  }

  /** フォルダがあるか */
  async folderExists(name: string): Promise<boolean> {
    return (await stat(this.folderPathOf(name)).catch(() => undefined))?.isDirectory() ?? false;
  }

  async list(): Promise<ModelInfo[]> {
    return (await this.tree()).models;
  }

  /**
   * 作業フォルダの中のモデルと、一覧に出すフォルダを返す。サブフォルダの中も（何段でも）たどる。
   * 出すフォルダは、中に（サブフォルダの中も含めて）モデルがあるフォルダと、空のフォルダ（ファイルが 1 つもない。空のサブフォルダだけがあるのも含む）。
   * モデルがなく、ほかのファイルだけがあるフォルダ（exports/ のような書き出し先）と、先頭が . のフォルダは出さない
   */
  async tree(): Promise<ModelTree> {
    const models: ModelInfo[] = [];
    const folders: FolderInfo[] = [];
    // rel のフォルダの中のモデルの数と、ファイルがあるか（空でないか）を返す。出すフォルダは folders に親のすぐあとに入れる
    const walk = async (rel: string): Promise<{ count: number; files: boolean }> => {
      let entries: Dirent[];
      try {
        entries = await readdir(rel ? path.join(this.dir, rel) : this.dir, { withFileTypes: true });
      } catch {
        // 読めないフォルダは、中身が分からないので空とは扱わない
        return { count: 0, files: true };
      }
      let count = 0;
      let files = false;
      const subs: string[] = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          // 先頭が . のフォルダ（.git など）は出さないが、中身はあるものとして扱う
          if (e.name.startsWith(".")) files = true;
          else subs.push(e.name);
          continue;
        }
        if (!isOSFile(e.name)) files = true;
        if (!isModelFile(e.name)) continue;
        const name = (rel ? `${rel}/` : "") + e.name.replace(/\.json$/i, "");
        try {
          checkModelName(name);
        } catch {
          // モデル名に使えない名前のファイル（先頭が . など）は出さない
          continue;
        }
        const info = await readInfo(path.join(this.dir, rel, e.name), name, rel);
        if (info) {
          models.push(info);
          count++;
        }
      }
      for (const sub of subs.sort(compareNames)) {
        const subRel = rel ? `${rel}/${sub}` : sub;
        const at = folders.length;
        const r = await walk(subRel);
        count += r.count;
        files ||= r.files;
        // モデルがなく、ほかのファイルだけがあるフォルダは、その中のフォルダごと出さない
        if (r.count === 0 && r.files) folders.splice(at);
        else folders.splice(at, 0, { name: subRel, models: r.count });
      }
      return { count, files };
    };
    await walk("");
    models.sort((a, b) => compareNames(a.name, b.name));
    return { models, folders };
  }

  /** 付属のファイル（実際のデータ、筋書き）も含めた、モデルのファイル */
  private filesOf(name: string): string[] {
    return [this.pathOf(name), this.dataPathOf(name), this.slidesPathOf(name)];
  }

  /** ないモデルを指したときのエラー */
  private async notFound(name: string): Promise<StoreError> {
    const names = (await this.list()).map((m) => m.name);
    return new StoreError(
      `モデル "${name}" が見つかりません。` + (names.length ? `あるモデル: ${names.join(", ")}` : "作業フォルダにモデルがありません。"),
    );
  }

  /**
   * モデルを別のフォルダへ動かす・名前を変える。付属のファイル（<名前>.data.csv、<名前>.slides.json）もいっしょに動かす。
   * 行き先のフォルダがなければ作る。行き先に同じ名前のモデル（か付属のファイル）があれば断る。
   * exports/ に書き出した資料は動かさない
   */
  async moveModel(from: string, to: string): Promise<{ from: string; to: string; files: string[] }> {
    const src = checkModelName(from);
    const dst = checkModelName(to);
    if (src === dst) throw new StoreError(`モデル "${src}" の行き先が、今と同じ名前です。`);
    if (!(await this.exists(src))) throw await this.notFound(src);
    const [srcFiles, dstFiles] = [this.filesOf(src), this.filesOf(dst)];
    // 大文字と小文字だけを変えるとき（Windows と macOS）は、行き先は自分自身なので確かめない
    if (fileKey(src) !== fileKey(dst)) {
      for (const f of dstFiles) {
        if (await exists(f)) throw new StoreError(`行き先に同じ名前のファイル（${path.relative(this.dir, f)}）があるため、動かしませんでした。別の名前にしてください。`);
      }
    }
    // これから作るフォルダ（深い順）。動かせなかったときに消す
    const created: string[] = [];
    for (let d = path.dirname(dstFiles[0]!); d.length > this.dir.length && !(await exists(d)); d = path.dirname(d)) created.push(d);
    await mkdir(path.dirname(dstFiles[0]!), { recursive: true });
    // 付属のファイルを先に、モデル（.json）を最後に動かす。途中で動かせなければ（Excel で開かれているなど）、動かしたものを元に戻す。
    // モデルだけが動いて、付属のファイルが元の場所に残らないように
    const moved: [string, string][] = [];
    for (const i of [1, 2, 0]) {
      const [a, b] = [srcFiles[i]!, dstFiles[i]!];
      if (!(await exists(a))) continue;
      try {
        await rename(a, b);
      } catch (e) {
        for (const [x, y] of moved.reverse()) await rename(y, x).catch(() => undefined);
        // 作ったフォルダを深いほうから消す（rmdir は空でなければ失敗するので、戻せなかったファイルは消さない）
        for (const d of created) if (!(await rmdir(d).then(() => true, () => false))) break;
        throw new StoreError(`${path.relative(this.dir, a)} を動かせなかったため、モデルを動かしませんでした（${(e as Error).message}）。${BUSY}`);
      }
      moved.push([a, b]);
    }
    return { from: src, to: dst, files: moved.map(([, b]) => b) };
  }

  /**
   * モデルを消す。<名前>.json と付属のファイル（<名前>.data.csv、<名前>.slides.json）をいっしょに消す
   * （残すと、あとで同じ名前のモデルを作ったときに、古い実際のデータや筋書きがそのモデルのものとして読まれるため）。
   * exports/ に書き出した資料は消さない
   */
  async removeModel(name: string): Promise<{ model: string; files: string[] }> {
    const n = checkModelName(name);
    if (!(await this.exists(n))) throw await this.notFound(n);
    // 付属のファイルを先に、モデル（.json）を最後に消す。付属のファイルを消せなければ（Excel で開かれているなど）、モデルは残す。
    // モデルだけが消えて、古い実際のデータや筋書きが残らないように
    const [json, ...extras] = this.filesOf(n);
    const removed: string[] = [];
    for (const f of [...extras, json!]) {
      if (!(await exists(f))) continue;
      try {
        await unlink(f);
      } catch (e) {
        const done = removed.length ? `（${removed.map((r) => path.relative(this.dir, r)).join("、")} は消しました）` : "";
        throw new StoreError(`${path.relative(this.dir, f)} を消せなかったため、モデルは消していません${done}（${(e as Error).message}）。${BUSY}`);
      }
      removed.push(f);
    }
    return { model: n, files: removed };
  }

  /** フォルダを作る（サブフォルダも。途中のフォルダがなければ作る）。すでにあれば何もせず created: false を返す */
  async createFolder(name: string): Promise<{ folder: string; dir: string; created: boolean }> {
    const n = checkFolderName(name);
    const dir = this.folderPathOf(n);
    const st = await stat(dir).catch(() => undefined);
    if (st && !st.isDirectory()) throw new StoreError(`"${n}" はファイルです。`);
    if (!st) await mkdir(dir, { recursive: true });
    return { folder: n, dir, created: !st };
  }

  /**
   * フォルダを別の場所へ動かす・名前を変える（中のモデルと付属のファイルごと）。行き先のフォルダの親がなければ作る。
   * 行き先に同じ名前のフォルダかファイルがあれば断る。返す models は、動かしたあとのモデル名
   */
  async moveFolder(from: string, to: string): Promise<{ from: string; to: string; models: string[] }> {
    const src = checkFolderName(from);
    const dst = checkFolderName(to);
    if (src === dst) throw new StoreError(`フォルダ "${src}" の行き先が、今と同じ名前です。`);
    if (!(await this.folderExists(src))) throw await this.folderNotFound(src);
    if (fileKey(dst).startsWith(`${fileKey(src)}/`)) throw new StoreError(`フォルダ "${src}" を、その中のフォルダ（${dst}）へは動かせません。`);
    if (fileKey(src) !== fileKey(dst) && (await exists(this.folderPathOf(dst)))) {
      throw new StoreError(`行き先に同じ名前のフォルダかファイル（${dst}）があるため、動かしませんでした。別の名前にしてください。`);
    }
    const prefix = `${fileKey(src)}/`;
    const inside = (await this.list()).filter((m) => fileKey(m.name).startsWith(prefix)).map((m) => dst + m.name.slice(src.length));
    await mkdir(path.dirname(this.folderPathOf(dst)), { recursive: true });
    await rename(this.folderPathOf(src), this.folderPathOf(dst));
    return { from: src, to: dst, models: inside };
  }

  /**
   * 空のフォルダを消す。空のサブフォルダだけがあるときは、それもいっしょに消す。
   * 中にファイルが 1 つでもあれば消さない（OS が作るファイル .DS_Store などは数えず、いっしょに消す）
   */
  async removeFolder(name: string): Promise<{ folder: string; dir: string }> {
    const n = checkFolderName(name);
    const dir = this.folderPathOf(n);
    if (!(await this.folderExists(n))) throw await this.folderNotFound(n);
    const dirs: string[] = [];
    const osFiles: string[] = [];
    const others: string[] = [];
    const walk = async (d: string) => {
      dirs.push(d);
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (isOSFile(e.name)) osFiles.push(p);
        else others.push(path.relative(this.dir, p).split(path.sep).join("/"));
      }
    };
    await walk(dir);
    if (others.length) {
      const shown = others.slice(0, 5).join(", ") + (others.length > 5 ? ` ほか ${others.length - 5} 個` : "");
      throw new StoreError(`フォルダ "${n}" の中にファイルがあるため、消しませんでした（${shown}）。モデルは remove_model で消すか、move_model でほかへ動かしてください。`);
    }
    for (const f of osFiles) await unlink(f);
    // 深いフォルダから消す（中が空でなければ rmdir は失敗するので、途中でファイルができても消さない）
    for (const d of dirs.reverse()) await rmdir(d);
    return { folder: n, dir };
  }

  /** ないフォルダを指したときのエラー */
  private async folderNotFound(name: string): Promise<StoreError> {
    const names = (await this.tree()).folders.map((f) => f.name);
    return new StoreError(`フォルダ "${name}" が見つかりません。` + (names.length ? `あるフォルダ: ${names.join(", ")}` : "作業フォルダにフォルダがありません。"));
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
      throw await this.notFound(name);
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
