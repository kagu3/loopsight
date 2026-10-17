// ビューアのサーバーと画面のあいだでやりとりする形（型だけ。画面からも import type で使う）
import type { EditReport, ElementPatch, Equation, Issue, ModelElement, ModelInfo, ModelJSON, RemoveTarget, Scenario, ScenarioPatch, ScenarioReport, Slide, SlideDeck, SlideIssue } from "../core/index.js";

export type { EditReport, ElementPatch, Equation, Issue, ModelElement, ModelInfo, ModelJSON, RemoveTarget, Scenario, ScenarioPatch, ScenarioReport, Slide, SlideDeck, SlideIssue };

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

/** 会議資料の筋書き（<モデル名>.slides.json）。読めなかったときは deck がなく、issues にその理由が入る */
export interface SlidesResult {
  file: string;
  /** 版（ファイルの中身のハッシュ）。モデルとは別に持つ。筋書きだけが変わったときに、画面が気づけるように */
  version: string;
  deck?: SlideDeck;
  /** 名前がモデルに合わないなど、筋書きの問題（作業画面の「問題」に出す。発表モードには出さない） */
  issues: SlideIssue[];
}

/**
 * 保存したシナリオ 1 つ分の実行結果。時刻は「元のモデル」（RunResult）と同じ。
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
  /** 実行できたときの結果（何も変えない実行。「元のモデル」） */
  run?: RunResult;
  /** モデルにシナリオが保存されていれば、その実行結果。モデルの並び順 */
  scenarios?: ScenarioRunResult[];
  /** 実行できなかったときの理由 */
  run_error?: { message: string; issues: Issue[] };
  /** 実際のデータ（あるときだけ） */
  actual?: ActualDataResult;
  /** 会議資料の筋書き（あるときだけ） */
  slides?: SlidesResult;
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

/** POST /api/models/:name/scenarios の本文。scenarios と remove は MCP の set_scenarios と同じ形 */
export interface ScenariosRequest {
  version: string;
  scenarios: ScenarioPatch[];
  /** 消すシナリオの名前 */
  remove?: string[];
}

/** POST /api/models/:name/remove の本文。elements は MCP の remove_elements と同じ形 */
export interface RemoveRequest {
  version: string;
  elements: RemoveTarget[];
}

/** POST /api/models/:name/undo の本文 */
export interface UndoRequest {
  version: string;
}

/** 書き込みの結果。成功すると新しいモデルを返す */
export interface EditResponse {
  /** 要素の編集なら EditReport、シナリオの編集なら ScenarioReport */
  report?: EditReport | ScenarioReport;
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

/** 書き込みの要求に付けるヘッダー。これがないと書き込みを断る（ほかのサイトから送れないように） */
export const VIEWER_HEADER = "X-IM-Viewer";
