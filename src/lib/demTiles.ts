// DEM（標高）タイルの取得・キャッシュ・標高サンプリング。
//
// データ: 国土地理院 標高タイル（DEM10B, .txt 形式）
//   https://cyberjapandata.gsi.go.jp/xyz/dem/{z}/{x}/{y}.txt
//   - 1タイル = 256x256 の標高値(m)。CSV、欠測は "e"。
//   - z14 がネイティブ(約10m)。CORS開放・APIキー不要。
//   - 出典表記が必要:「標高データ：国土地理院 標高タイル」。
//
// fetch / Cache API を使うため主にワーカー側で利用する。mount-photo-sim の dem.ts を
// この単機能アプリ向けに整理したもの。

import { TILE_SIZE } from "./mercator";

export const DEM_TILE_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem/{z}/{x}/{y}.txt";
// DEM10B のネイティブズーム。これ以上拡大しても標高は細かくならない（航空写真だけ高精細化）。
export const DEM_MAX_Z = 14;
const TILE_CACHE_NAME = "gsi-dem-tiles-v1";

type Grid = Float32Array; // 長さ 256*256、欠測は NaN
const parsedCache = new Map<string, Grid>();
const PARSED_LRU_MAX = 512;

function parseTileText(text: string): Grid {
  const grid = new Float32Array(TILE_SIZE * TILE_SIZE);
  const rows = text.trim().split("\n");
  for (let y = 0; y < TILE_SIZE && y < rows.length; y++) {
    const cols = rows[y].split(",");
    for (let x = 0; x < TILE_SIZE && x < cols.length; x++) {
      const v = cols[x];
      grid[y * TILE_SIZE + x] = v === "e" || v === "" ? NaN : parseFloat(v);
    }
  }
  return grid;
}

// 同一タイルの同時取得を1回にまとめる。
const inflight = new Map<string, Promise<Grid | null>>();

/**
 * DEMタイル（パース済み標高グリッド）を取得。メモリLRU → 同時取得dedup → Cache API → ネット。
 * 取得失敗（ネット不通・404＝海域など）は null を返す（呼び出し側で海面0扱い）。
 */
export function fetchDemTile(z: number, x: number, y: number): Promise<Grid | null> {
  const key = `${z}/${x}/${y}`;
  const hit = parsedCache.get(key);
  if (hit) {
    parsedCache.delete(key);
    parsedCache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = loadDemTile(z, x, y, key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function loadDemTile(z: number, x: number, y: number, key: string): Promise<Grid | null> {
  const url = DEM_TILE_URL.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));

  let cache: Cache | null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(TILE_CACHE_NAME) : null;
  } catch {
    cache = null;
  }

  let text: string | null = null;
  if (cache) {
    const cached = await cache.match(url);
    if (cached) text = await cached.text();
  }
  if (text == null) {
    let res: Response;
    try {
      res = await fetch(url, { mode: "cors" });
    } catch {
      return null; // オフライン・未キャッシュ
    }
    if (res.status === 404) return null; // 海域など DEM 無し
    if (!res.ok) return null;
    text = await res.text();
    if (cache) {
      await cache.put(url, new Response(text, { headers: { "content-type": "text/plain" } }));
    }
  }

  const grid = parseTileText(text);
  parsedCache.set(key, grid);
  if (parsedCache.size > PARSED_LRU_MAX) {
    const oldest = parsedCache.keys().next().value;
    if (oldest) parsedCache.delete(oldest);
  }
  return grid;
}

/**
 * 事前ロード用: DEMタイルの生テキストを Cache API に確保する（パースしない＝メモリを汚さない）。
 * すでにキャッシュ済みなら何もしない。戻り値は「キャッシュに存在する状態になったか」。
 */
export async function prefetchDemTile(z: number, x: number, y: number): Promise<boolean> {
  const url = DEM_TILE_URL.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
  let cache: Cache | null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(TILE_CACHE_NAME) : null;
  } catch {
    cache = null;
  }
  if (cache && (await cache.match(url))) return true;
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors" });
  } catch {
    return false;
  }
  if (res.status === 404) return true; // 海域＝DEM無し。落とすものが無いので成功扱い。
  if (!res.ok) return false;
  const text = await res.text();
  if (cache) await cache.put(url, new Response(text, { headers: { "content-type": "text/plain" } }));
  return true;
}
