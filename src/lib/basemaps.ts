// 地形にドレープする「ベースマップ」レイヤの定義と取得。
//
// すべて国土地理院の XYZ タイル（APIキー不要・CORS開放）。地形タイル(z,x,y)に
// ちょうど1枚を貼るので合成は不要。fetch → Blob → ImageBitmap で読み込み、
// Cache API にも保存する（オフライン事前ロードと共通の永続キャッシュ）。
//   出典表記:「地図・写真・標高データ：国土地理院タイル」。

export type Basemap = {
  id: string;
  label: string;
  url: string; // {z}/{x}/{y} を含むテンプレート
  maxZoom: number;
};

// 切替候補。航空写真＝既定。標準地図は登山道・地名が載るので登山に有用。
export const BASEMAPS: Basemap[] = [
  { id: "photo", label: "航空写真", url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", maxZoom: 18 },
  { id: "std", label: "標準地図", url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", maxZoom: 18 },
  { id: "pale", label: "淡色地図", url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", maxZoom: 18 },
  { id: "relief", label: "陰影起伏", url: "https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png", maxZoom: 16 },
];

export const DEFAULT_BASEMAP = BASEMAPS[0];

export function basemapById(id: string): Basemap {
  return BASEMAPS.find((b) => b.id === id) ?? DEFAULT_BASEMAP;
}

const TILE_CACHE_NAME = "gsi-basemap-tiles-v1";

function tileUrl(layer: Basemap, z: number, x: number, y: number): string {
  return layer.url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

const inflight = new Map<string, Promise<ImageBitmap | null>>();

/** ベースマップタイルを ImageBitmap で取得。取得不可（海域・オフライン）は null。 */
export function fetchBasemapTile(
  layer: Basemap,
  z: number,
  x: number,
  y: number,
): Promise<ImageBitmap | null> {
  const url = tileUrl(layer, z, x, y);
  const pending = inflight.get(url);
  if (pending) return pending;
  const p = load(url).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches !== "undefined" ? await caches.open(TILE_CACHE_NAME) : null;
  } catch {
    return null;
  }
}

async function load(url: string): Promise<ImageBitmap | null> {
  const cache = await openCache();
  let blob: Blob | null = null;
  if (cache) {
    const hit = await cache.match(url);
    if (hit) blob = await hit.blob();
  }
  if (!blob) {
    // 一時的なネットワーク失敗は数回リトライする。大量読込時に fetch が例外で落ちると
    // タイルが無地(海色)のまま“ready”確定して再取得されず、地図に無地ポリゴンが残るため。
    // 404（=海域・データ無し）は正当なので即 null（リトライしない）。
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(url, { mode: "cors" });
        break;
      } catch {
        if (attempt === 2) return null;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    if (!res || !res.ok) return null; // 404=海域など
    blob = await res.blob();
    if (cache) await cache.put(url, new Response(blob, { headers: { "content-type": blob.type } }));
  }
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * 事前ロード用: ベースマップタイルの生データを Cache API に確保する（デコードしない）。
 * すでにキャッシュ済みなら何もしない。戻り値は「キャッシュに存在する状態になったか」。
 */
export async function prefetchBasemapTile(
  layer: Basemap,
  z: number,
  x: number,
  y: number,
): Promise<boolean> {
  const url = tileUrl(layer, z, x, y);
  const cache = await openCache();
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
  if (cache) await cache.put(url, new Response(blob, { headers: { "content-type": blob.type } }));
  return true;
}

/** タイルキャッシュ（DEM・ベースマップ）を削除する。 */
export async function clearTileCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  await Promise.all([caches.delete("gsi-dem-tiles-v1"), caches.delete(TILE_CACHE_NAME)]);
}
