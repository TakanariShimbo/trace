import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages のプロジェクトページでは base を "/<repo>/" にする必要がある。
//   - ローカル開発 / カスタムドメイン: base = "/"
//   - GitHub Pages: CI で VITE_BASE="/<repo>/" を渡す
const rawBase = process.env.VITE_BASE ?? "/";
const base = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        name: "GSI 3D Map — 国土地理院 3D地形ビュー",
        short_name: "GSI 3D Map",
        description:
          "国土地理院タイル(DEM＋航空写真)による Google Earth 風 ストリーミング3D地形ビュー。事前ロードでオフライン閲覧も。",
        lang: "ja",
        theme_color: "#0a0d12",
        background_color: "#0a0d12",
        display: "standalone",
        orientation: "any",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // アプリ本体（シェル）＋山岳データ(mountains.json)をプリキャッシュしオフライン起動可能に。
        // GSIタイルは demTiles/basemaps が独自に Cache API で扱うのでここには含めない。
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,json}"],
        navigateFallback: "index.html",
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: {
    format: "es",
  },
});
