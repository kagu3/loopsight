import { mkdtemp, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unsupportedElementsMessage, type ModelJSON } from "../src/core/index.js";

/** `simulation` に同梱されている ModelJSON のサンプル */
export const SAMPLES_DIR = path.resolve("node_modules/simulation/src/api/import_export/ModelJSON/samples");

/** 同梱のサンプルのうち、状態（STATE）と遷移（TRANSITION）を使うもの。ループサイトは読み込みで断る */
export const UNSUPPORTED_SAMPLE = "bathtub";

/** 同梱のサンプルのうち、ループサイトが扱えるもの（状態と遷移を含むものを除く） */
export function sampleNames(): string[] {
  return readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((name) => !unsupportedElementsMessage(loadSample(name).elements));
}

export function loadSample(name: string): ModelJSON {
  return JSON.parse(readFileSync(path.join(SAMPLES_DIR, `${name}.json`), "utf8")) as ModelJSON;
}

export const FIXTURES_DIR = path.resolve("tests/fixtures");

export async function tempDir(): Promise<string> {
  return promisify(mkdtemp)(path.join(tmpdir(), "im-mcp-"));
}

/** 名前順に並べた要素（比較用） */
export function sortedElements(model: ModelJSON) {
  return [...model.elements].sort((a, b) =>
    `${a.type}:${a.name ?? ""}:${a.from ?? ""}:${a.to ?? ""}`.localeCompare(`${b.type}:${b.name ?? ""}:${b.from ?? ""}:${b.to ?? ""}`),
  );
}
