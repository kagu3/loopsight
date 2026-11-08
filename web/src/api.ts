// サーバーとのやりとり。画面（web/src）がサーバーとやりとりするのは、ここだけにする。
// デモサイトのビルド（npm run build:demo）では、サーバーの代わりに、ブラウザの中のモデル（demo/store.ts）を読み書きする
import type { DemoStore } from "./demo/store.js";
import {
  VIEWER_HEADER,
  type AnnotationPatch,
  type DiagramExportResponse,
  type EditErrorResponse,
  type EditResponse,
  type ElementPatch,
  type GroupPatch,
  type ModelListResponse,
  type ModelResponse,
  type RemoveTarget,
  type ScenarioPatch,
  type SimulationSettings,
} from "../../src/viewer/api.js";
import type { WriteAction, WriteBody } from "../../src/viewer/shared.js";

/** デモサイトのビルド（vite build --mode demo）か。デモでは、サーバーに書かせる機能（図の書き出し）と、変更の知らせ（/api/events）を使わない */
export const DEMO = import.meta.env.MODE === "demo";

// デモのときだけ、sample とブラウザの中のモデルを読み込む（ふつうのビルドには入れない）
let demoStore: Promise<DemoStore> | undefined;
const demo = () =>
  (demoStore ??= Promise.all([import("./demo/store.js"), import("./demo/samples.js")]).then(([{ DemoStore }, { SAMPLES, SAMPLE_DATA }]) => new DemoStore(SAMPLES, SAMPLE_DATA)));

/** 読めなかったときのエラー。status はサーバーの応答の番号（404 ならモデルのファイルがない） */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new FetchError(body.error ?? `${res.status}`, res.status);
  return body;
}

export const fetchList = async (): Promise<ModelListResponse> => (DEMO ? (await demo()).list() : getJSON<ModelListResponse>("/api/models"));

export async function fetchModel(name: string): Promise<ModelResponse> {
  if (!DEMO) return getJSON<ModelResponse>(`/api/models/${encodeURIComponent(name)}`);
  const store = await demo();
  try {
    return store.get(name);
  } catch (e) {
    throw new FetchError((e as Error).message, (e as { status?: number }).status ?? 500);
  }
}

/** 書き込みの結果。ok でなければ、conflict のときは current に最新が入る */
export type WriteResult = { ok: true; data: EditResponse } | { ok: false; error: EditErrorResponse };

/** 書き込む。action は POST /api/models/:name/<action> の種類 */
async function post(name: string, action: WriteAction, body: { version: string; [key: string]: unknown }): Promise<WriteResult> {
  if (DEMO) {
    const res = (await demo()).write(name, action, body as unknown as WriteBody & { version: string });
    return res.status === 200 ? { ok: true, data: res.body as EditResponse } : { ok: false, error: res.body as EditErrorResponse };
  }
  let res: Response;
  try {
    res = await fetch(`/api/models/${encodeURIComponent(name)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [VIEWER_HEADER]: "1" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: { error: `サーバーにつながりません: ${(e as Error).message}` } };
  }
  const json = (await res.json().catch(() => ({ error: `${res.status}` }))) as EditResponse | EditErrorResponse;
  return res.ok ? { ok: true, data: json as EditResponse } : { ok: false, error: json as EditErrorResponse };
}

/** 要素を足す・直す。annotations（注釈の変更。MCP の set_annotations と同じ形）があれば、同じ 1 回の保存で変える */
export const postEdit = (name: string, version: string, elements: ElementPatch[], annotations?: AnnotationPatch[]) =>
  post(name, "edit", annotations?.length ? { version, elements, annotations } : { version, elements });

/** 要素を消す。elements は MCP の remove_elements と同じ形。annotations は消す注釈の id */
export const postRemove = (name: string, version: string, elements: RemoveTarget[], annotations?: string[]) =>
  post(name, "remove", annotations?.length ? { version, elements, annotations } : { version, elements });

/** シナリオを足す・直す・消す。scenarios と remove は MCP の set_scenarios と同じ形 */
export const postScenarios = (name: string, version: string, scenarios: ScenarioPatch[], remove?: string[]) =>
  post(name, "scenarios", remove?.length ? { version, scenarios, remove } : { version, scenarios });

/** シミュレーションの設定を直す。simulation は MCP の set_simulation と同じ形（変えた項目だけ） */
export const postSimulation = (name: string, version: string, simulation: SimulationSettings) => post(name, "simulation", { version, simulation });

export const postUndo = (name: string, version: string) => post(name, "undo", { version });

/** 図のグループを足す・直す・消す。groups と remove は MCP の set_groups と同じ形 */
export const postGroups = (name: string, version: string, groups: GroupPatch[], remove?: string[]) =>
  post(name, "groups", remove?.length ? { version, groups, remove } : { version, groups });
/** 図を書き出した SVG と PNG（base64）を送り、作業フォルダの exports/<モデル名>/ に書いてもらう（デモにはない） */
export async function postDiagramExport(name: string, svg: string, png: string): Promise<{ ok: true; data: DiagramExportResponse } | { ok: false; error: string }> {
  if (DEMO) return { ok: false, error: "デモでは図を書き出せません。" };
  let res: Response;
  try {
    res = await fetch(`/api/models/${encodeURIComponent(name)}/export-diagram`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [VIEWER_HEADER]: "1" },
      body: JSON.stringify({ svg, png }),
    });
  } catch (e) {
    return { ok: false, error: `サーバーにつながりません: ${(e as Error).message}` };
  }
  const json = (await res.json().catch(() => ({ error: `${res.status}` }))) as DiagramExportResponse & { error?: string };
  return res.ok ? { ok: true, data: json } : { ok: false, error: json.error ?? `${res.status}` };
}
