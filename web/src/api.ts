// サーバーとのやりとり
import {
  VIEWER_HEADER,
  type AnnotationPatch,
  type EditErrorResponse,
  type EditResponse,
  type ElementPatch,
  type GroupPatch,
  type ModelListResponse,
  type ModelResponse,
  type RemoveTarget,
  type ScenarioPatch,
} from "../../src/viewer/api.js";

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

export const fetchList = () => getJSON<ModelListResponse>("/api/models");
export const fetchModel = (name: string) => getJSON<ModelResponse>(`/api/models/${encodeURIComponent(name)}`);

/** 書き込みの結果。ok でなければ、conflict のときは current に最新が入る */
export type WriteResult = { ok: true; data: EditResponse } | { ok: false; error: EditErrorResponse };

async function post(url: string, body: unknown): Promise<WriteResult> {
  let res: Response;
  try {
    res = await fetch(url, {
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
  post(`/api/models/${encodeURIComponent(name)}/edit`, annotations?.length ? { version, elements, annotations } : { version, elements });

/** 要素を消す。elements は MCP の remove_elements と同じ形。annotations は消す注釈の id */
export const postRemove = (name: string, version: string, elements: RemoveTarget[], annotations?: string[]) =>
  post(`/api/models/${encodeURIComponent(name)}/remove`, annotations?.length ? { version, elements, annotations } : { version, elements });

/** シナリオを足す・直す・消す。scenarios と remove は MCP の set_scenarios と同じ形 */
export const postScenarios = (name: string, version: string, scenarios: ScenarioPatch[], remove?: string[]) =>
  post(`/api/models/${encodeURIComponent(name)}/scenarios`, remove?.length ? { version, scenarios, remove } : { version, scenarios });

export const postUndo = (name: string, version: string) => post(`/api/models/${encodeURIComponent(name)}/undo`, { version });

/** 図のグループを足す・直す・消す。groups と remove は MCP の set_groups と同じ形 */
export const postGroups = (name: string, version: string, groups: GroupPatch[], remove?: string[]) =>
  post(`/api/models/${encodeURIComponent(name)}/groups`, remove?.length ? { version, groups, remove } : { version, groups });
