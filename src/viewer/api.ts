// ビューアのサーバーと画面のあいだでやりとりする形（型だけ。画面からも import type で使う）
import type { Issue, ModelElement, ModelInfo, ModelJSON } from "../core/index.js";

export type { Issue, ModelElement, ModelInfo, ModelJSON };

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
