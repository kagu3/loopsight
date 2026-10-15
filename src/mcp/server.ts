import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ModelStore, resolveModelsDir } from "../core/index.js";
import { SERVER_INSTRUCTIONS, registerTools } from "./tools.js";

export const SERVER_NAME = "insight-maker";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  /** 作業フォルダ。省略すると環境変数 INSIGHT_MAKER_MODELS_DIR、それもなければ ./models */
  modelsDir?: string;
}

/** MCP サーバーを作る。ツールの登録はここにまとめる。 */
export function createServer(options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, new ModelStore(resolveModelsDir(options.modelsDir)));
  return server;
}
