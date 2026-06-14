// 一覧カード用サムネ（山頂の斜め3D静止画）を全山ぶん生成する。
// 稼働中の playwright-cli ブラウザを使い、#/__thumbs ハーネスの window.__renderThumb で
// webp(dataURL) を作らせ、public/thumbs/<id>.webp に保存する。既存はスキップ＝再開可能。
//
// 事前: dev/preview サーバを起動し、playwright-cli で #/__thumbs を開いておくこと。
//   npx --no-install playwright-cli goto "http://localhost:5173/#/__thumbs"
//   npx --no-install playwright-cli reload   # ハッシュのみだと再ルートされないため
// 使い方: node scripts/gen-thumbs.mjs [chunkSize] [maxCount]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "public", "thumbs");
fs.mkdirSync(outDir, { recursive: true });

const mountains = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "mountains.json"), "utf8"));
// 地理的に近い順（北→南、同緯度内は西→東）で作る。隣接する山は地形タイルを共有するので、
// 1サイクル内でキャッシュが効いて高速化する（表示順はアプリ側で別管理なので影響なし）。
mountains.sort((a, b) => b.latitude - a.latitude || a.longitude - b.longitude);

const chunkSize = Number(process.argv[2] || 8);
const maxCount = Number(process.argv[3] || Infinity);

const todo = mountains.filter((m) => !fs.existsSync(path.join(outDir, `${m.id}.webp`))).slice(0, maxCount);
console.log(`対象 ${todo.length} 座 / 全 ${mountains.length} 座（既存はスキップ）`);

const cli = (expr) =>
  execFileSync("npx", ["--no-install", "playwright-cli", "--raw", "eval", expr], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();

// ハーネスが準備できているか確認。
if (cli("String(window.__thumbReady)").replace(/"/g, "") !== "true") {
  console.error("window.__thumbReady が true ではありません。#/__thumbs を開いて reload してください。");
  process.exit(1);
}

let done = 0;
const t0 = Date.now();
for (let i = 0; i < todo.length; i += chunkSize) {
  const chunk = todo.slice(i, i + chunkSize);
  // チャンクの [id,lat,lon,elev] をブラウザへ渡し、順に描いて [id,base64] を JSON で返す。
  const arr = JSON.stringify(chunk.map((m) => [m.id, m.latitude, m.longitude, m.elevation_m]));
  const expr =
    `(async () => { const out = []; for (const [id, la, lo, el] of ${arr}) {` +
    ` try { const d = await window.__renderThumb(la, lo, el); out.push([id, d.split(",")[1]]); }` +
    ` catch (e) { out.push([id, null]); } } return JSON.stringify(out); })()`;
  let res;
  try {
    res = JSON.parse(JSON.parse(cli(expr))); // --raw は文字列を二重引用符で返すため2段パース
  } catch (e) {
    console.error(`チャンク ${i} 失敗:`, e.message);
    continue;
  }
  for (const [id, b64] of res) {
    if (!b64) {
      console.warn(`  id=${id} 失敗`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, `${id}.webp`), Buffer.from(b64, "base64"));
    done++;
  }
  const rate = done / ((Date.now() - t0) / 1000);
  const remain = Math.round((todo.length - done) / Math.max(rate, 0.01));
  console.log(`  ${done}/${todo.length}（${rate.toFixed(1)}/s, 残り約${Math.round(remain / 60)}分）`);
}
console.log(`完了: ${done} 枚を生成（${outDir}）`);
