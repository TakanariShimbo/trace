// 航空写真タイルの取得。地形タイル(z,x,y)にちょうど1枚を貼るので合成は不要。
//
// データ: 国土地理院 シームレス空中写真（.jpg、APIキー不要・CORS開放、z2〜18）
//   https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg
//   出典表記が必要:「画像：国土地理院 シームレス空中写真」。
//
// fetch → Blob → ImageBitmap で読み込み、Cache API にも保存する（将来のオフライン
// 事前ダウンロードと共通の永続キャッシュ）。CORS開放タイルなので canvas/GPU を汚さない。

const SEAMLESSPHOTO_URL =
  "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";
// シームレス空中写真の最大ズーム。
export const AERIAL_MAX_Z = 18;
const TILE_CACHE_NAME = "gsi-aerial-tiles-v1";

const inflight = new Map<string, Promise<ImageBitmap | null>>();

/** 航空写真タイル(z,x,y)を ImageBitmap で取得。取得不可（海域・オフライン）は null。 */
export function fetchAerialTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const key = `${z}/${x}/${y}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = load(z, x, y).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function load(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const url = SEAMLESSPHOTO_URL.replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));

  let cache: Cache | null;
  try {
    cache = typeof caches !== "undefined" ? await caches.open(TILE_CACHE_NAME) : null;
  } catch {
    cache = null;
  }

  let blob: Blob | null = null;
  if (cache) {
    const hit = await cache.match(url);
    if (hit) blob = await hit.blob();
  }
  if (!blob) {
    let res: Response;
    try {
      res = await fetch(url, { mode: "cors" });
    } catch {
      return null;
    }
    if (!res.ok) return null; // 404=海域など
    blob = await res.blob();
    if (cache) await cache.put(url, new Response(blob, { headers: { "content-type": "image/jpeg" } }));
  }

  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * 事前ロード用: 航空写真タイルの生 JPEG を Cache API に確保する（デコードしない）。
 * すでにキャッシュ済みなら何もしない。戻り値は「キャッシュに存在する状態になったか」。
 */
export async function prefetchAerialTile(z: number, x: number, y: number): Promise<boolean> {
  const url = SEAMLESSPHOTO_URL.replace("{z}", String(z))
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
  if (res.status === 404) return true; // 海域＝写真無し。成功扱い。
  if (!res.ok) return false;
  const blob = await res.blob();
  if (cache) await cache.put(url, new Response(blob, { headers: { "content-type": "image/jpeg" } }));
  return true;
}

/** タイルキャッシュ（DEM・航空写真の両方）を削除する。 */
export async function clearTileCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  await Promise.all([caches.delete("gsi-dem-tiles-v1"), caches.delete(TILE_CACHE_NAME)]);
}
