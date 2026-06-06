// Web メルカトル(EPSG:3857) ⇄ 経緯度 ⇄ XYZタイル ⇄ 3Dワールド座標 の変換。
//
// このモジュールは DOM/fetch を一切使わない純粋計算なので、メインスレッドと
// ワーカーの両方から import できる（タイルの経緯度サンプリングを両側で一致させる）。
//
// 3Dワールド座標系:
//   - 原点は日本の中心付近 (ORIGIN_LAT/LON)。表示領域の座標が小さくなり float32 精度に有利。
//   - 単位はおよそ「キロメートル」。水平はメルカトルの引き伸ばし(1/cosφ)を基準緯度の
//     cos で補正して実距離に近づける（日本スケールでは十分自然）。
//   - X=東, Z=北, Y=標高（上）。Y は VERTICAL_EXAGGERATION 倍して見やすくする。

export const TILE_SIZE = 256;

// メルカトル投影に使う地球半径（EPSG:3857）。
const MERC_R = 6378137;
const MERC_MAX = Math.PI * MERC_R; // 20037508.342789244

// ワールド原点（日本の中心付近）。
export const ORIGIN_LAT = 36;
export const ORIGIN_LON = 137.5;

// 標高の強調倍率。1=実スケール(X/Y/Z等倍)。広域では山が潰れて見えるので既定で少し強調。
// 実行時に変更可能（サイドバーのスライダー）。変更後は地形メッシュの作り直しが必要。
export const VERTICAL_EXAGGERATION_DEFAULT = 1.7;
let verticalExaggeration = VERTICAL_EXAGGERATION_DEFAULT;
export function setVerticalExaggeration(v: number): void {
  verticalExaggeration = v;
}
export function getVerticalExaggeration(): number {
  return verticalExaggeration;
}

// 日本の概略 bbox（ルートタイル・事前ロード範囲のクランプに使う。小笠原などは除外）。
export const JAPAN_BBOX = { latMin: 20, latMax: 46, lonMin: 122, lonMax: 154 };

function lonToMercX(lon: number): number {
  return (lon * Math.PI) / 180 * MERC_R;
}
function latToMercY(lat: number): number {
  const rad = (lat * Math.PI) / 180;
  return MERC_R * Math.log(Math.tan(Math.PI / 4 + rad / 2));
}
function mercXToLon(mx: number): number {
  return (mx / MERC_R) * 180 / Math.PI;
}
function mercYToLat(my: number): number {
  return (2 * Math.atan(Math.exp(my / MERC_R)) - Math.PI / 2) * 180 / Math.PI;
}

// 原点のメルカトル座標と水平スケール（メルカトルm → ワールドkm）。
const ORIGIN_MX = lonToMercX(ORIGIN_LON);
const ORIGIN_MY = latToMercY(ORIGIN_LAT);
// メルカトルmは引き伸ばされている。基準緯度の cos を掛けて実距離に近づけ、/1000 で km。
const WORLD_SCALE = Math.cos((ORIGIN_LAT * Math.PI) / 180) / 1000;
// VEX=1 のときの標高スケール（水平と同じ＝実寸 1:1:1）。実際は VEX を掛ける。
const ELEV_BASE = Math.cos((ORIGIN_LAT * Math.PI) / 180) / 1000;

/** メルカトルX(m) → ワールドX（東+）。 */
export function mercXToWorld(mx: number): number {
  return (mx - ORIGIN_MX) * WORLD_SCALE;
}
/** メルカトルY(m) → ワールドZ（北 = -Z）。
 * X=東 / Y=上 / Z=南 とすることで Three.js の右手系と一致し、鏡像表示を防ぐ
 * （東×上 = -北 なので、北を -Z にすると右手系になる）。 */
export function mercYToWorld(my: number): number {
  return -(my - ORIGIN_MY) * WORLD_SCALE;
}
/** 標高(m) → ワールドY（上+、現在の VEX を反映）。 */
export function elevToWorldY(elevM: number): number {
  return elevM * ELEV_BASE * verticalExaggeration;
}

/** ワールド水平座標(X=東, Z=南) → 経緯度（mercYToWorld の逆。事前ロード範囲の算出に使う）。 */
export function worldToLonLat(wx: number, wz: number): { lat: number; lon: number } {
  const mx = wx / WORLD_SCALE + ORIGIN_MX;
  const my = -wz / WORLD_SCALE + ORIGIN_MY;
  return { lat: mercYToLat(my), lon: mercXToLon(mx) };
}

export type TileId = { z: number; x: number; y: number };

/** タイル(z,x,y) のメルカトル境界(m)。 */
export function tileMercBounds(z: number, x: number, y: number): {
  mxMin: number; mxMax: number; myMin: number; myMax: number;
} {
  const n = 2 ** z;
  const span = (2 * MERC_MAX) / n; // 1タイルのメルカトル幅(m)
  const mxMin = -MERC_MAX + x * span;
  const mxMax = mxMin + span;
  // タイル y=0 が上(北)。メルカトルYは上が +。
  const myMax = MERC_MAX - y * span;
  const myMin = myMax - span;
  return { mxMin, mxMax, myMin, myMax };
}

/** タイル境界 → 経緯度の矩形（NW/SE）。 */
export function tileLonLatBounds(z: number, x: number, y: number): {
  latN: number; latS: number; lonW: number; lonE: number;
} {
  const b = tileMercBounds(z, x, y);
  return {
    latN: mercYToLat(b.myMax),
    latS: mercYToLat(b.myMin),
    lonW: mercXToLon(b.mxMin),
    lonE: mercXToLon(b.mxMax),
  };
}

/** 経緯度 → タイル座標(整数)。 */
export function lonLatToTile(lat: number, lon: number, z: number): TileId {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n,
  );
  return { z, x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)) };
}

/** 経緯度 → そのズームでのグローバルピクセル座標（Webメルカトル、DEMサンプル用）。 */
export function lonLatToGlobalPixel(lat: number, lon: number, z: number): { gx: number; gy: number } {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  return { gx: fx * TILE_SIZE, gy: fy * TILE_SIZE };
}

export { mercXToLon, mercYToLat, lonToMercX, latToMercY };
