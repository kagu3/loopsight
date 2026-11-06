import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// 画面のビルド。dist/web に出し、ビューアのサーバー（src/viewer）が配信する。
// 開発中は npm run dev:web で起動し、/api はビューアのサーバー（既定 5180）に回す。
// --mode demo（npm run build:demo）では、サーバーなしで sample を触れるデモサイトを dist/demo に出す。
// GitHub Pages の https://kagu3.github.io/loopsight/ に置くので、base を /loopsight/ にする
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    root: fileURLToPath(new URL(".", import.meta.url)),
    base: demo ? "/loopsight/" : "/",
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL(demo ? "../dist/demo" : "../dist/web", import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 2000,
    },
    server: demo ? {} : { proxy: { "/api": { target: "http://localhost:5180", changeOrigin: true } } },
  };
});
