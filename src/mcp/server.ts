import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SERVER_NAME = "insight-maker";
export const SERVER_VERSION = "0.1.0";

/** MCP サーバーを作る。ツールの登録はここにまとめる。 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  return server;
}
