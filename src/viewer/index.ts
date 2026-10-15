#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveModelsDir } from "../core/index.js";
import { startViewer } from "./server.js";

const { values } = parseArgs({ options: { "models-dir": { type: "string" }, port: { type: "string" } }, strict: false });
const modelsDir = resolveModelsDir(typeof values["models-dir"] === "string" ? values["models-dir"] : undefined);
const port = typeof values.port === "string" ? Number(values.port) : Number(process.env.INSIGHT_MAKER_VIEWER_PORT ?? 5180);

// ビルドした画面は dist/web にある（このファイルは dist/viewer/index.js）
const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const viewer = await startViewer({ modelsDir, staticDir, port });
console.log(`Insight Maker ビューア: ${viewer.url}`);
console.log(`作業フォルダ: ${modelsDir}`);

const stop = () => {
  viewer.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
