#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_VIEWER_PORT, ENV_VARS, VIEWER_OPTIONS, resolveModelsDir } from "../core/index.js";
import { startViewer } from "./server.js";

const { values } = parseArgs({ options: VIEWER_OPTIONS, strict: false });
const modelsDir = resolveModelsDir(typeof values["models-dir"] === "string" ? values["models-dir"] : undefined);
const port = typeof values.port === "string" ? Number(values.port) : Number(process.env[ENV_VARS.viewerPort] ?? DEFAULT_VIEWER_PORT);

// ビルドした画面は dist/web にある（このファイルは dist/viewer/index.js）
const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
let viewer: Awaited<ReturnType<typeof startViewer>>;
try {
  viewer = await startViewer({ modelsDir, staticDir, port });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
    console.error(`ポート ${port} はほかのプログラムが使っています。ビューアがもう起動しているなら、http://localhost:${port}/ を開いてください。`);
    console.error(`別のポートで起動するには: npm run viewer -- --port ${port + 1}`);
    process.exit(1);
  }
  throw e;
}
console.log(`Loopsight ビューア: ${viewer.url}`);
console.log(`作業フォルダ: ${modelsDir}`);

const stop = () => {
  viewer.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
