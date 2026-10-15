// ビューアのサーバーと画面のあいだでやりとりする形（型だけ。画面からも import type で使う）
import type { EditReport, ElementPatch, Issue, ModelElement, ModelInfo, ModelJSON } from "../core/index.js";

export type { EditReport, ElementPatch, Issue, ModelElement, ModelInfo, ModelJSON };

/** GET /api/models */
export interface ModelListResponse {
  dir: string;
  models: ModelInfo[];
}

/** 実行結果。series は要素名 → 各時刻の値（数値にできない値は null） */
export interface RunResult {
  time_units: string;
  times: number[];
  series: Record<string, (number | null)[]>;
}

/** GET /api/models/:name */
export interface ModelResponse {
  name: string;
  modified: string;
  /** 版（ファイルの中身のハッシュ）。書き込むときに送り返す */
  version: string;
  /** 画面からの変更を元に戻せる回数 */
  undo_available: number;
  model: ModelJSON;
  validation: { ok: boolean; errors: Issue[]; warnings: Issue[] };
  /** 実行できたときの結果 */
  run?: RunResult;
  /** 実行できなかったときの理由 */
  run_error?: { message: string; issues: Issue[] };
}

/** GET /api/events で送るイベント。どのモデルのファイルが変わったか */
export interface ChangeEvent {
  type: "changed" | "removed";
  name: string;
}

/** POST /api/models/:name/edit の本文。elements は MCP の upsert_elements と同じ形 */
export interface EditRequest {
  version: string;
  elements: ElementPatch[];
}

/** POST /api/models/:name/undo の本文 */
export interface UndoRequest {
  version: string;
}

/** 書き込みの結果。成功すると新しいモデルを返す */
export interface EditResponse {
  report?: EditReport;
  model: ModelResponse;
}

/** 書き込めなかったとき。conflict はほかから先に変えられていた場合で、current に最新を入れる */
export interface EditErrorResponse {
  error: string;
  conflict?: boolean;
  current?: ModelResponse;
}

/** 書き込みの要求に付けるヘッダー。これがないと書き込みを断る（ほかのサイトから送れないように） */
export const VIEWER_HEADER = "X-IM-Viewer";
