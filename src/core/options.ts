// 起動引数と環境変数の一覧。MCP サーバー（src/mcp/index.ts）とビューア（src/viewer/index.ts）が読む。
// 足したら、docs/reference/model-format.md の「起動引数と環境変数」の表にも書く（書き忘れると tests/docs-model-format.test.ts が落ちる）

/** 環境変数の名前 */
export const ENV_VARS = {
  /** 作業フォルダ（起動引数 --models-dir がないときに使う）。MCP サーバーとビューア */
  modelsDir: "LOOPSIGHT_MODELS_DIR",
  /** ビューアのポート（起動引数 --port がないときに使う） */
  viewerPort: "LOOPSIGHT_VIEWER_PORT",
  /** 図を画像にするときに使う Edge か Chrome の場所（src/viewer/browser.ts） */
  browserPath: "BROWSER_PATH",
} as const;

/** MCP サーバーの起動引数（node:util の parseArgs にそのまま渡す） */
export const MCP_OPTIONS = {
  "models-dir": { type: "string" },
} as const;

/** ビューアの起動引数（node:util の parseArgs にそのまま渡す） */
export const VIEWER_OPTIONS = {
  "models-dir": { type: "string" },
  port: { type: "string" },
} as const;

/** ビューアのポートの既定 */
export const DEFAULT_VIEWER_PORT = 5180;
