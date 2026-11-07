// デモサイトの「サーバーの代わり」。ブラウザの中で、メモリ上のモデルを読み書きする。
// 返す形はビューアのサーバー（src/viewer/server.ts）と同じで、確かめと実行は src/viewer/shared.ts の同じ処理を使う。
// 実際のデータ（<モデル名>.data.csv）も、モデルと同じようにメモリに持ち、グラフに点で重ねる。
// 変更はメモリにだけ持つので、ページを読み直すと元の sample に戻る。元に戻す（undo）の記録もメモリの中だけに持つ。
// Node.js の API は使わない（tests/viewer-shared.test.ts で確かめる）。動きがサーバーとずれていないことは tests/demo-store.test.ts で確かめる
import type { EditErrorResponse, EditResponse, FolderInfo, ModelInfo, ModelListResponse, ModelResponse } from "../../../src/viewer/api.js";
import { renameDataHeader } from "../../../src/core/data.js";
import { EditError } from "../../../src/core/edit.js";
import type { ModelJSON } from "../../../src/core/modeljson.js";
import { CONFLICT_MESSAGE, NOTHING_TO_UNDO, RequestError, actualDataResult, applyWrite, buildModelResponse, modelText, pushHistory, type HistoryEntry, type WriteAction, type WriteBody } from "../../../src/viewer/shared.js";

/** 読めなかったときのエラー。status はサーバーと同じ番号（404 ならモデルがない） */
export class DemoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 書き込みの結果。status はサーバーが返す番号と同じ */
export type DemoWriteResult = { status: number; body: EditResponse | EditErrorResponse };

/**
 * ファイルの中身から版を作る（中身が同じなら同じ版）。サーバーは sha256 を使うが、ブラウザで同期して計算できるよう、
 * 短いハッシュ（cyrb53）にする。版は「読んでから書くまでに変わっていないか」を見るだけなので、これで足りる
 */
export function demoVersion(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** エクスプローラーと同じように、大文字と小文字を区別せず、数字は数の大きさの順に並べる（src/core/store.ts の compareNames と同じ） */
const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
const compareNames = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const folderOf = (name: string) => (name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "");

export class DemoStore {
  /** モデル名 → いまの中身（ModelJSON の文字列） */
  private readonly texts = new Map<string, string>();
  /** モデル名 → 実際のデータ（<モデル名>.data.csv の中身）。グラフに点で重ねる */
  private readonly data = new Map<string, string>();
  /** 画面からの書き込みの記録（モデル名 → 古い順） */
  private readonly history = new Map<string, HistoryEntry[]>();
  /** 最後に作った応答（同じ版を読み直すたびに実行し直さないように） */
  private readonly cache = new Map<string, ModelResponse>();

  /**
   * models はモデル名（フォルダを含む。例：0_コーヒーが冷める/coffee-cooling）→ ModelJSON の文字列。
   * data はモデル名 → 実際のデータ（CSV の中身）。モデルのないデータは使わない。
   * dir は一覧に出す作業フォルダの名前、modified はすべてのモデルの「変えた時刻」（どれも同じにする）
   */
  constructor(
    models: Record<string, string>,
    data: Record<string, string> = {},
    private readonly dir = "examples",
    private readonly modified = "2026-01-01T00:00:00.000Z",
  ) {
    for (const name of Object.keys(models).sort(compareNames)) this.texts.set(name, models[name]!);
    for (const [name, text] of Object.entries(data)) if (this.texts.has(name)) this.data.set(name, text);
  }

  /** 名前に当たるモデル。大文字と小文字は区別しない（Windows と macOS のファイル名に合わせる） */
  private find(name: string): string {
    if (this.texts.has(name)) return name;
    const lower = name.toLowerCase();
    const found = [...this.texts.keys()].find((n) => n.toLowerCase() === lower);
    if (!found) throw new DemoError(`モデル "${name}" が見つかりません。`, 404);
    return found;
  }

  private historyOf(name: string): HistoryEntry[] {
    if (!this.history.has(name)) this.history.set(name, []);
    return this.history.get(name)!;
  }

  /** GET /api/models と同じ。sample のフォルダとモデル */
  list(): ModelListResponse {
    const models: ModelInfo[] = [];
    const counts = new Map<string, number>();
    for (const [name, text] of this.texts) {
      const folder = folderOf(name);
      let json: Partial<ModelJSON> = {};
      try {
        json = JSON.parse(text) as Partial<ModelJSON>;
      } catch {
        // 読めないモデルも一覧には出す（開くとエラーを出す）
      }
      models.push({
        name,
        folder,
        file: `${this.dir}/${name}.json`,
        title: typeof json.name === "string" ? json.name : undefined,
        elements: Array.isArray(json.elements) ? json.elements.length : 0,
        modified: this.modified,
      });
      // 親のフォルダすべてに数える
      const parts = folder ? folder.split("/") : [];
      parts.forEach((_, i) => {
        const f = parts.slice(0, i + 1).join("/");
        counts.set(f, (counts.get(f) ?? 0) + 1);
      });
    }
    const folders: FolderInfo[] = [...counts].sort(([a], [b]) => compareNames(a, b)).map(([name, n]) => ({ name, models: n }));
    return { dir: this.dir, models, folders };
  }

  /** いまの中身と、その版 */
  private current(name: string): { model: ModelJSON; version: string; text: string } {
    const text = this.texts.get(name)!;
    let model: ModelJSON;
    try {
      model = JSON.parse(text) as ModelJSON;
    } catch (e) {
      throw new DemoError(`${name} を ModelJSON として読めません: ${(e as Error).message}`, 404);
    }
    return { model, version: demoVersion(text), text };
  }

  /** GET /api/models/:name と同じ */
  get(name: string): ModelResponse {
    const key = this.find(name);
    const { model, version } = this.current(key);
    const undo = this.historyOf(key).length;
    const data = this.data.get(key);
    const dataVersion = data === undefined ? undefined : demoVersion(data);
    const cached = this.cache.get(key);
    if (cached && cached.version === version && cached.undo_available === undo && cached.actual?.version === dataVersion) return cached;
    // 実際のデータのファイル名は、サーバーと同じく <モデル名の最後の部分>.data.csv
    const actual = data === undefined ? undefined : actualDataResult(model, data, `${key.slice(key.lastIndexOf("/") + 1)}.data.csv`, dataVersion!);
    const res = buildModelResponse({ name: key, modified: this.modified, version, undoAvailable: undo, model, actual });
    this.cache.set(key, res);
    return res;
  }

  /** 要素の名前を変えたときに、実際のデータの列名も直す（src/core/store.ts の renameDataColumns と同じ知らせを返す） */
  private renameDataColumns(name: string, renames: [string, string][]): { note?: string; warning?: string } {
    const text = this.data.get(name);
    if (!renames.length || text === undefined) return {};
    const file = `${name.slice(name.lastIndexOf("/") + 1)}.data.csv`;
    try {
      const next = renameDataHeader(text, renames);
      if (next === undefined) return {};
      this.data.set(name, next);
      return { note: `実際のデータ（${file}）の列名も直しました。` };
    } catch (e) {
      return { warning: `実際のデータ（${file}）の列名を直せませんでした（${(e as Error).message}）。列名を要素名にそろえてください。` };
    }
  }

  /** POST /api/models/:name/<action> と同じ。version はいま画面に出している版 */
  write(name: string, action: WriteAction, body: WriteBody & { version: string }): DemoWriteResult {
    try {
      if (typeof body?.version !== "string") throw new RequestError(400, "version がありません。");
      const key = this.find(name);
      const current = this.current(key);
      const hist = this.historyOf(key);
      // デモでは、ほかのところから変えられることはない。念のためサーバーと同じに確かめる
      if (current.version !== body.version) return { status: 409, body: { error: CONFLICT_MESSAGE, conflict: true, current: this.get(key) } };
      if (action !== "undo") {
        const { report, renamed } = applyWrite(current.model, action, body);
        const text = modelText(current.model);
        this.texts.set(key, text);
        pushHistory(hist, { before: current.text, after: demoVersion(text), renamed });
        // 実際のデータの列名も、サーバーと同じく直す
        const data = this.renameDataColumns(key, renamed);
        if (data.note && report && "notes" in report) report.notes.push(data.note);
        return { status: 200, body: { ...(report ? { report } : {}), model: this.get(key), ...(data.warning ? { warning: data.warning } : {}), ...(renamed.length ? { renamed } : {}) } };
      }
      const last = hist.pop();
      if (!last) throw new RequestError(400, NOTHING_TO_UNDO);
      this.texts.set(key, last.before);
      const back = last.renamed.map(([from, to]): [string, string] => [to, from]);
      const data = this.renameDataColumns(key, back);
      return { status: 200, body: { model: this.get(key), ...(data.warning ? { warning: data.warning } : {}), ...(back.length ? { renamed: back } : {}) } };
    } catch (e) {
      const status = e instanceof RequestError ? e.status : e instanceof DemoError ? e.status : e instanceof EditError ? 400 : 500;
      return { status, body: { error: (e as Error).message } };
    }
  }
}
