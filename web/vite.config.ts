import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 画面のビルド。dist/web に出し、ビューアのサーバー（src/viewer）が配信する。
// 開発中は npm run dev:web で起動し、/api はビューアのサーバー（既定 5180）に回す。
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    proxy: { "/api": { target: "http://localhost:5180", changeOrigin: true } },
  },
});
