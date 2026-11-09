// ビューアのサーバーと画面のあいだでやりとりする形（型だけ。画面からも import type で使う）
import type { AnnotationPatch, BaselinePatch, EditReport, ElementPatch, Equation, FolderInfo, GroupPatch, GroupReport, Issue, ModelElement, ModelInfo, ModelJSON, RemoveTarget, Scenario, ScenarioPatch, ScenarioReport, SimulationSettings } from "../core/index.js";

export type { AnnotationPatch, BaselinePatch, EditReport, ElementPatch, Equation, FolderInfo, GroupPatch, GroupReport, Issue, ModelElement, ModelInfo, ModelJSON, RemoveTarget, Scenario, ScenarioPatch, ScenarioReport, SimulationSettings };

/**
 * GET /api/models。モデルと、一覧に出すフォルダ（モデルがあるフォルダと空のフォルダ）。
 * モデル名はフォルダを含む作業フォルダからの相対パス（ブルックスの法則/brooks_law）。/api/models/:name などでは encodeURIComponent して送る
 */
export interface ModelListResponse {
  dir: string;
  models: ModelInfo[];
  folders: FolderInfo[];
}

/** 実行結果。series は要素名 → 各時刻の値（数値にできない値は null） */
export interface RunResult {
  time_units: string;
  times: number[];
  series: Record<string, (number | null)[]>;
}

/** 実際のデータ（<モデル名>.data.csv）。series は要素名 → 各時刻の値（空欄は null）。要素に合う列だけ入れる */
export interface ActualDataResult {
  file: string;
  /** 版（ファイルの中身のハッシュ）。CSV だけが変わったときに、画面が気づけるように */
  version: string;
  times: number[];
  series: Record<string, (number | null)[]>;
  /** 読めなかったときや、要素に合わない列があるときの知らせ */
  issues: Issue[];
}

/**
 * 保存したシナリオ 1 つ分の実行結果。時刻は何も変えない実行（RunResult）と同じ。
 * 実行できなかったときは series の代わりに error が入る。画面で重ねられる数を超えたシナリオは実行せず、skipped にする
 */
export interface ScenarioRunResult {
  name: string;
  description?: string;
  values: Record<string, Equation>;
  series?: Record<string, (number | null)[]>;
  error?: string;
  skipped?: boolean;
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
  /** 実行できたときの結果（何も変えない実行。名前と説明はモデルの baseline） */
  run?: RunResult;
  /** モデルにシナリオが保存されていれば、その実行結果。モデルの並び順 */
  scenarios?: ScenarioRunResult[];
  /** 実行できなかったときの理由 */
  run_error?: { message: string; issues: Issue[] };
  /** 実際のデータ（あるときだけ） */
  actual?: ActualDataResult;
}

/**
 * GET /api/events で送るイベント。どのモデルのファイルが変わったか。
 * folders は、フォルダを作った・消した・動かしたときや、モデルでないファイルが変わったとき（中のどのモデルが変わったかは分からないので、一覧と開いているモデルを読み直す）
 */
export type ChangeEvent = { type: "changed" | "removed"; name: string } | { type: "folders" };

/**
 * POST /api/models/:name/edit の本文。elements は MCP の upsert_elements と同じ形。
 * annotations（注釈の変更。MCP の set_annotations と同じ形）もあれば、同じ 1 回の保存で変える（図をまとめて動かしたときなど）。
 * annotations があれば elements は空でよい
 */
export interface EditRequest {
  version: string;
  elements: ElementPatch[];
  annotations?: AnnotationPatch[];
}

/** POST /api/models/:name/scenarios の本文。scenarios、remove、baseline は MCP の set_scenarios と同じ形 */
export interface ScenariosRequest {
  version: string;
  scenarios: ScenarioPatch[];
  /** 消すシナリオの名前 */
  remove?: string[];
  /** 何も変えない実行の名前と説明を直す。あれば scenarios は空でよい */
  baseline?: BaselinePatch;
}

/** POST /api/models/:name/groups の本文。groups と remove は MCP の set_groups と同じ形 */
export interface GroupsRequest {
  version: string;
  groups: GroupPatch[];
  /** 消すグループの名前 */
  remove?: string[];
}

/** POST /api/models/:name/simulation の本文。simulation は MCP の set_simulation と同じ形（指定しなかった項目はそのまま） */
export interface SimulationRequest {
  version: string;
  simulation: SimulationSettings;
}

/** POST /api/models/:name/remove の本文。elements は MCP の remove_elements と同じ形。annotations は消す注釈の id（あれば elements は空でよい） */
export interface RemoveRequest {
  version: string;
  elements: RemoveTarget[];
  annotations?: string[];
}

/** POST /api/models/:name/undo の本文 */
export interface UndoRequest {
  version: string;
}

/** 書き込みの結果。成功すると新しいモデルを返す */
export interface EditResponse {
  /** 要素の編集なら EditReport、シナリオの編集なら ScenarioReport、グループの編集なら GroupReport */
  report?: EditReport | ScenarioReport | GroupReport;
  model: ModelResponse;
  /** 書き込めたが、知らせたいこと（実際のデータの列名を直せなかったときなど） */
  warning?: string;
  /** 名前の変わった要素の [前の名前, 新しい名前]（名前を変えた・元に戻したとき）。画面で選んでいる要素を新しい名前に合わせるため */
  renamed?: [string, string][];
}

/** 書き込めなかったとき。conflict はほかから先に変えられていた場合で、current に最新を入れる */
export interface EditErrorResponse {
  error: string;
  conflict?: boolean;
  current?: ModelResponse;
}

/**
 * POST /api/models/:name/export-diagram の本文。画面の図を書き出した SVG と PNG（base64）。
 * サーバーは作業フォルダの exports/<モデル名>/diagram.svg と diagram.png に書く（MCP の export_diagram と同じ書き出し先）
 */
export interface DiagramExportRequest {
  svg: string;
  png: string;
}

/** 図を書き出した結果。dir は書き出したフォルダ、files は書いたファイル（どちらも絶対パス） */
export interface DiagramExportResponse {
  dir: string;
  files: string[];
}

/** 書き込みの要求に付けるヘッダー。これがないと書き込みを断る（ほかのサイトから送れないように） */
export const VIEWER_HEADER = "X-IM-Viewer";
