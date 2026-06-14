// 写真AR の仕上げ用「3Dミニマップ・スタンプ」。
//
// 撮影地点と対象の山を中心に DEM タイルから狭域のハイトマップを作り、
// Three.js のオフスクリーン WebGL でアイソメ風（OrthographicCamera）にレンダして
// 透過 PNG 化する。座標・タイル取得は既存の mercator.ts / demTiles.ts を経由。
//
// 出力: 正方形の HTMLCanvasElement（透過、preserveDrawingBuffer 済み）。
// 呼び出し側は drawImage で写真キャンバスに合成する。
//
// 描画方位: headingDeg（真北=0, 東=90, CW）が渡されればスタンプの上方向＝撮影方向に
// 合わせる。未指定または orientationMode==="north" のときは北上固定。

import * as THREE from "three";
import { fetchDemTile, DEM_MAX_Z } from "./demTiles";
import {
  TILE_SIZE,
  lonToMercX,
  latToMercY,
  mercXToLon,
  mercYToLat,
  lonLatToGlobalPixel,
} from "./mercator";
import { loadAllMountains, type MountainHit } from "./mountains";

export type StampStyle = "contour" | "shaded" | "wire";
export type StampOrientation = "heading" | "north";

export type TerrainStampInput = {
  center: { lat: number; lon: number };
  mountainId?: number;
  rangeKm?: number;
  style?: StampStyle;
  accent?: string;
  headingDeg?: number | null;
  orientationMode?: StampOrientation;
  /** 出力スタンプの正方サイズ（px）。既定 512。写真合成側で縮小して使う。 */
  size?: number;
};

export type StampMountain = {
  id?: number;
  name: string;
  lat: number;
  lon: number;
  elevationM: number;
};

export type TerrainStampResult = {
  canvas: HTMLCanvasElement; // 透過の正方画像
  mountain: StampMountain | null;
  effectiveHeadingDeg: number; // 実際に向きに使った角度（0=北上）
  oriented: boolean; // true=撮影方位に合わせた / false=北上
};

const DEFAULTS = {
  rangeKm: 3,
  style: "contour" as StampStyle,
  accent: "#d8ff4a",
  orientationMode: "heading" as StampOrientation,
  size: 512,
};

const GRID_N = 128; // 出力解像度
const PLANE_SIZE = 1.0; // ワールド単位（任意。ortho カメラでフィットさせる）
const HEIGHT_SPAN = 0.32; // 標高のワールド高さ最大（PLANE_SIZE 比）
const VERTICAL_EXAGGERATION = 1.6;

// 共有 WebGLRenderer（モジュール内シングルトン）。renderTerrainStamp を呼ぶたびに
// 新規 WebGL コンテキストを作るとモバイルでタブのコンテキスト上限(~16)に達して
// 古いコンテキストが失われる。プレビュー(スライダー連打)が壊れないよう使い回す。
// scene/geometry/material は呼び出しごとに作って dispose する。
let sharedRenderer: THREE.WebGLRenderer | null = null;
function acquireRenderer(size: number): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    sharedRenderer.setPixelRatio(1);
    sharedRenderer.setClearColor(0x000000, 0);
  }
  sharedRenderer.setSize(size, size, false);
  return sharedRenderer;
}

/**
 * 半径(rangeKm)・緯度・格子数から DEM ズームを決める。1セルが mercator px で
 * 概ね 4〜8 になる程度を狙う（z14 がネイティブなのでそれ以上は上げない）。
 */
function pickDemZoom(rangeKm: number, lat: number, gridN: number): number {
  // 1セルの実距離(m)
  const cellRealM = (2 * rangeKm * 1000) / gridN;
  const cosLat = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  // mercator m は 1/cosφ 倍に引き伸ばされている。
  const cellMercM = cellRealM / cosLat;
  // ズーム z での1mercator pxの長さ(m): 2*PI*R / (2^z * 256)
  // 解像度比 cellMercM / pxM ≈ 6 をターゲットに z を選ぶ。
  const MERC_M_TOTAL = 2 * Math.PI * 6378137;
  const pxAtZ0 = MERC_M_TOTAL / TILE_SIZE;
  const target = (cellMercM / pxAtZ0) * (1 / 3); // 1セル ≈ 3 mercator px
  const z = Math.log2(1 / target);
  return Math.max(8, Math.min(DEM_MAX_Z, Math.round(z)));
}

/**
 * 範囲(rangeKm 半径)に収まる最高標高の山を mountains.json から選ぶ。
 * mountainId が指定されていればそれを優先。該当無しなら null。
 */
async function pickRepresentativeMountain(
  center: { lat: number; lon: number },
  rangeKm: number,
  mountainId: number | undefined,
): Promise<MountainHit | null> {
  const list = await loadAllMountains();
  if (mountainId != null) {
    const hit = list.find((m) => m.id === mountainId);
    if (hit) return hit;
  }
  // 緯度1度 ≈ 111km、経度1度 ≈ 111km*cosφ。半径 rangeKm を簡易判定。
  const cosLat = Math.max(0.1, Math.cos((center.lat * Math.PI) / 180));
  const dLat = rangeKm / 111;
  const dLon = rangeKm / (111 * cosLat);
  let best: MountainHit | null = null;
  for (const m of list) {
    if (Math.abs(m.lat - center.lat) > dLat) continue;
    if (Math.abs(m.lon - center.lon) > dLon) continue;
    if (!best || m.elevationM > best.elevationM) best = m;
  }
  return best;
}

/** 緑→白の高度カラー（shaded スタイル用）。0..1 を渡す。 */
function elevationColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  if (c < 0.5) {
    // 暗緑 → 緑
    const k = c / 0.5;
    return [0.13 + 0.32 * k, 0.32 + 0.42 * k, 0.18 + 0.18 * k];
  }
  // 緑 → 茶 → 白
  const k = (c - 0.5) / 0.5;
  return [0.45 + 0.55 * k, 0.74 + 0.26 * k, 0.36 + 0.64 * k];
}

/**
 * 等高線セグメントを生成する（行優先のハイト配列から各セルごとに iso-line を抽出）。
 * 値は正規化高さ (0..1)。出力は (x, y, z) の配列ペア（LineSegments 用）。
 */
function buildContourSegments(
  heights: Float32Array,
  N: number,
  planeSize: number,
  baseY: (h: number) => number,
  levels: number[],
): Float32Array {
  const verts = N + 1;
  const stride = planeSize / N;
  const x0 = -planeSize / 2;
  const z0 = -planeSize / 2;
  const out: number[] = [];
  // 各セル(i, j)〜(i+1, j+1) について、4辺で iso 通過点を集める。
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const h00 = heights[j * verts + i];
      const h10 = heights[j * verts + (i + 1)];
      const h01 = heights[(j + 1) * verts + i];
      const h11 = heights[(j + 1) * verts + (i + 1)];
      for (const lv of levels) {
        const pts: [number, number, number][] = [];
        // セル4辺: (00→10) (10→11) (00→01) (01→11)
        const edges: [number, number, number, number, number, number, number, number][] = [
          [h00, h10, i, j, i + 1, j, 0, 0],
          [h10, h11, i + 1, j, i + 1, j + 1, 0, 0],
          [h00, h01, i, j, i, j + 1, 0, 0],
          [h01, h11, i, j + 1, i + 1, j + 1, 0, 0],
        ];
        for (const e of edges) {
          const a = e[0], b = e[1];
          // (a, b) が lv を跨ぐ条件: 符号付き差の積が ≤0（端点が lv ちょうどでも採用）。
          // 両端が完全一致のとき (a==b==lv 含む) は退化なのでスキップ。
          if (a === b) continue;
          if ((a - lv) * (b - lv) > 0) continue;
          const t = (lv - a) / (b - a);
          const ax = x0 + e[2] * stride;
          const az = z0 + e[3] * stride;
          const bx = x0 + e[4] * stride;
          const bz = z0 + e[5] * stride;
          pts.push([ax + (bx - ax) * t, baseY(lv), az + (bz - az) * t]);
        }
        // 通過点が 2 つあれば 1 本の線分。4 点（saddle）は単純に対角ペアで結ぶ。
        if (pts.length >= 2) {
          out.push(pts[0][0], pts[0][1], pts[0][2], pts[1][0], pts[1][1], pts[1][2]);
          if (pts.length === 4) {
            out.push(pts[2][0], pts[2][1], pts[2][2], pts[3][0], pts[3][1], pts[3][2]);
          }
        }
      }
    }
  }
  return new Float32Array(out);
}

/**
 * ハイトマップを生成する（必要な DEM タイルを Cache 優先で取得 → バイリニア補間）。
 * 戻り値: heights(長さ (N+1)^2), hMin, hMax, sizeMercatorM, mxC, myC, gridN
 */
async function buildHeightmap(
  centerLat: number,
  centerLon: number,
  rangeKm: number,
  headingRad: number,
  gridN: number,
): Promise<{
  heights: Float32Array;
  hMin: number;
  hMax: number;
  sizeMercatorM: number;
  mxC: number;
  myC: number;
}> {
  const cosLat = Math.max(0.1, Math.cos((centerLat * Math.PI) / 180));
  // 実距離 2*rangeKm*1000 を覆う mercator m（mercator は 1/cosφ 倍に引き伸ばされている）。
  const sizeMercatorM = (2 * rangeKm * 1000) / cosLat;
  const mxC = lonToMercX(centerLon);
  const myC = latToMercY(centerLat);
  const verts = gridN + 1;

  // すべてのサンプル点（回転格子）の経緯度を求める。
  const lats = new Float64Array(verts * verts);
  const lons = new Float64Array(verts * verts);
  const cosH = Math.cos(headingRad);
  const sinH = Math.sin(headingRad);
  let bboxLatN = -90, bboxLatS = 90, bboxLonW = 180, bboxLonE = -180;
  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const pu = i / gridN - 0.5; // 右(+) ←→ 左(-)
      const pv = 0.5 - j / gridN; // 上(=撮影前方,+) ←→ 下(-)
      // heading=0 のとき pv=+ は北方向。
      const rotU = pu * cosH + pv * sinH;
      const rotV = -pu * sinH + pv * cosH;
      const mx = mxC + rotU * sizeMercatorM;
      const my = myC + rotV * sizeMercatorM;
      const lat = mercYToLat(my);
      const lon = mercXToLon(mx);
      lats[j * verts + i] = lat;
      lons[j * verts + i] = lon;
      if (lat > bboxLatN) bboxLatN = lat;
      if (lat < bboxLatS) bboxLatS = lat;
      if (lon < bboxLonW) bboxLonW = lon;
      if (lon > bboxLonE) bboxLonE = lon;
    }
  }

  const demZ = pickDemZoom(rangeKm, centerLat, gridN);

  // bbox を覆う DEM タイル一覧。
  const tileNW = lonLatToGlobalPixel(bboxLatN, bboxLonW, demZ);
  const tileSE = lonLatToGlobalPixel(bboxLatS, bboxLonE, demZ);
  const txMin = Math.floor(tileNW.gx / TILE_SIZE) - 1;
  const txMax = Math.ceil(tileSE.gx / TILE_SIZE) + 1;
  const tyMin = Math.floor(tileNW.gy / TILE_SIZE) - 1;
  const tyMax = Math.ceil(tileSE.gy / TILE_SIZE) + 1;
  const need: { tx: number; ty: number }[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      need.push({ tx, ty });
    }
  }
  const resolved = new Map<string, Float32Array | null>();
  await Promise.all(
    need.map(async ({ tx, ty }) => {
      resolved.set(`${tx}/${ty}`, await fetchDemTile(demZ, tx, ty));
    }),
  );

  const pixel = (gx: number, gy: number): number => {
    const g = resolved.get(`${Math.floor(gx / TILE_SIZE)}/${Math.floor(gy / TILE_SIZE)}`);
    if (!g) return NaN;
    const px = ((Math.floor(gx) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
    const py = ((Math.floor(gy) % TILE_SIZE) + TILE_SIZE) % TILE_SIZE;
    return g[py * TILE_SIZE + px];
  };

  const heights = new Float32Array(verts * verts);
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const { gx, gy } = lonLatToGlobalPixel(lats[k], lons[k], demZ);
    const fx = gx - 0.5;
    const fy = gy - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const dx = fx - x0;
    const dy = fy - y0;
    let sum = 0;
    let w = 0;
    const cs: [number, number, number][] = [
      [x0, y0, (1 - dx) * (1 - dy)],
      [x0 + 1, y0, dx * (1 - dy)],
      [x0, y0 + 1, (1 - dx) * dy],
      [x0 + 1, y0 + 1, dx * dy],
    ];
    for (const [cx, cy, wt] of cs) {
      const val = pixel(cx, cy);
      if (!Number.isNaN(val)) {
        sum += val * wt;
        w += wt;
      }
    }
    const h = w === 0 ? 0 : sum / w; // 欠測・海域は海面0
    heights[k] = h;
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  if (!isFinite(hMin)) hMin = 0;
  if (!isFinite(hMax)) hMax = hMin + 1;
  return { heights, hMin, hMax, sizeMercatorM, mxC, myC };
}

/**
 * 撮影地点・対象山周辺の DEM をスタンプ画像（透過 PNG 用 canvas）にレンダする。
 * 呼び出し元（写真ARの焼き込み）が drawImage で写真に貼り合わせる。
 */
export async function renderTerrainStamp(input: TerrainStampInput): Promise<TerrainStampResult> {
  const rangeKm = Math.max(1, Math.min(20, input.rangeKm ?? DEFAULTS.rangeKm));
  const style = input.style ?? DEFAULTS.style;
  const accent = input.accent ?? DEFAULTS.accent;
  const orientationMode = input.orientationMode ?? DEFAULTS.orientationMode;
  const size = Math.max(96, Math.round(input.size ?? DEFAULTS.size));

  // 中心の決定: mountainId 指定 or 近傍最高峰 or center 自体。
  const mt = await pickRepresentativeMountain(input.center, rangeKm, input.mountainId);
  const center = mt ? { lat: mt.lat, lon: mt.lon } : input.center;

  const oriented =
    orientationMode === "heading" &&
    input.headingDeg != null &&
    isFinite(input.headingDeg);
  const headingDeg = oriented ? (input.headingDeg as number) : 0;
  const headingRad = (headingDeg * Math.PI) / 180;

  const { heights, hMin, hMax, sizeMercatorM, mxC, myC } = await buildHeightmap(
    center.lat,
    center.lon,
    rangeKm,
    headingRad,
    GRID_N,
  );

  // === Three.js セットアップ ===
  // dispose() を持つもの（material/geometry）だけ後で回す。Mesh など捨てて良い参照は破棄不要。
  // 例外が出ても確実に解放できるよう、確保したものは即座に disposables に積んでから try に入る。
  const disposables: { dispose: () => void }[] = [];
  const renderer = acquireRenderer(size);
  const scene = new THREE.Scene();
  const verts = GRID_N + 1;
  const planeSize = PLANE_SIZE;
  const hRange = Math.max(1, hMax - hMin);
  const baseY = (norm: number) => norm * VERTICAL_EXAGGERATION * HEIGHT_SPAN;
  const geo = new THREE.PlaneGeometry(planeSize, planeSize, GRID_N, GRID_N);
  disposables.push(geo);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = size;
  outCanvas.height = size;
  let stampMountain: StampMountain | null = null;
  try {
  // 平面ジオメトリ。rotateX(-PI/2) で +Y を上に。
  geo.rotateX(-Math.PI / 2);
  // 標高を頂点 Y に流し込む。
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const heightsNorm = new Float32Array(heights.length);
  for (let k = 0; k < heights.length; k++) {
    const n = (heights[k] - hMin) / hRange;
    heightsNorm[k] = n;
    pos.setY(k, baseY(n));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();

  const accentColor = new THREE.Color(accent);

  // スタイル別マテリアル / 線
  if (style === "shaded") {
    // 標高グラデーション + ライト。
    const colors = new Float32Array(verts * verts * 3);
    for (let k = 0; k < heightsNorm.length; k++) {
      const [r, g, b] = elevationColor(heightsNorm[k]);
      colors[k * 3] = r;
      colors[k * 3 + 1] = g;
      colors[k * 3 + 2] = b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: false,
      metalness: 0.0,
      roughness: 0.85,
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    disposables.push(mat);
    const amb = new THREE.AmbientLight(0xffffff, 0.55);
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(0.4, 1.0, 0.5).normalize().multiplyScalar(3);
    scene.add(amb, sun);
  } else if (style === "wire") {
    const mat = new THREE.MeshBasicMaterial({
      color: accentColor,
      wireframe: true,
      transparent: true,
      opacity: 0.78,
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    disposables.push(mat);
  } else {
    // contour（既定・主役）: 暗いベース面 + 等高線。
    // ベース面は不透明・等高線は depthTest off で必ず手前に描く。両方 transparent にして
    // 同一深度で重ねると、等高線が暗いベース面に埋もれて accent 色が出ない。
    const baseMat = new THREE.MeshBasicMaterial({ color: 0x0e1620 });
    const baseMesh = new THREE.Mesh(geo, baseMat);
    scene.add(baseMesh);
    disposables.push(baseMat);
    // 等高線レベル（正規化高さ）。12 段。
    const levels: number[] = [];
    const stepN = 12;
    for (let i = 1; i < stepN; i++) levels.push(i / stepN);
    const segs = buildContourSegments(heightsNorm, GRID_N, planeSize, baseY, levels);
    if (segs.length > 0) {
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(segs, 3));
      const lineMat = new THREE.LineBasicMaterial({
        color: accentColor,
        transparent: true,
        opacity: 0.92,
        depthTest: false, // ベース面と同深度の Z ファイティングを避け、常に手前に描く
      });
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      lines.renderOrder = 1; // 透過描画パスの中でも後段に描く
      scene.add(lines);
      disposables.push(lineGeo, lineMat);
    }
  }

  // === 山頂ピン（対象の山に立てる） ===
  if (mt) {
    // 対象山の座標を回転格子局所系へ変換。
    const mx = lonToMercX(mt.lon);
    const my = latToMercY(mt.lat);
    const dx = (mx - mxC) / sizeMercatorM;
    const dy = (my - myC) / sizeMercatorM;
    const cosH = Math.cos(headingRad);
    const sinH = Math.sin(headingRad);
    // (rotU, rotV) を作る逆変換: build時 rotU = pu*cos + pv*sin, rotV = -pu*sin + pv*cos なので逆は
    //   pu = rotU*cos - rotV*sin, pv = rotU*sin + rotV*cos
    const pu = dx * cosH - dy * sinH;
    const pv = dx * sinH + dy * cosH;
    const peakX = pu * planeSize;
    const peakZ = -pv * planeSize;
    // 高さ補間（heightsの (i,j) は pu=i/N-0.5, pv=0.5-j/N）
    const ii = (pu + 0.5) * GRID_N;
    const jj = (0.5 - pv) * GRID_N;
    let peakY: number;
    if (ii >= 0 && ii <= GRID_N && jj >= 0 && jj <= GRID_N) {
      const i0 = Math.max(0, Math.min(GRID_N - 1, Math.floor(ii)));
      const j0 = Math.max(0, Math.min(GRID_N - 1, Math.floor(jj)));
      const tx = ii - i0;
      const tz = jj - j0;
      const h00 = heightsNorm[j0 * verts + i0];
      const h10 = heightsNorm[j0 * verts + i0 + 1];
      const h01 = heightsNorm[(j0 + 1) * verts + i0];
      const h11 = heightsNorm[(j0 + 1) * verts + i0 + 1];
      const h = h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
      peakY = baseY(h);
    } else {
      peakY = baseY(1);
    }
    stampMountain = { id: mt.id, name: mt.name, lat: mt.lat, lon: mt.lon, elevationM: mt.elevationM };

    // ステム（細い円柱）＋ヘッド（球）。色＝accent。
    const stemH = 0.13;
    const pinMat = new THREE.MeshBasicMaterial({ color: accentColor });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, stemH, 8), pinMat);
    stem.position.set(peakX, peakY + stemH / 2, peakZ);
    scene.add(stem);
    disposables.push(stem.geometry as THREE.BufferGeometry, pinMat);
    const headMat = new THREE.MeshBasicMaterial({ color: accentColor });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.014, 16, 12), headMat);
    head.position.set(peakX, peakY + stemH + 0.005, peakZ);
    scene.add(head);
    disposables.push(head.geometry as THREE.BufferGeometry, headMat);
  }

  // === カメラ: アイソメ風（俯角 ~35°）の OrthographicCamera ===
  // 対角線がフィットするように half = planeSize/sqrt(2)*1.05 程度。
  const half = (planeSize / 2) * 1.05;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, -10, 10);
  const pitchRad = (35 * Math.PI) / 180;
  // カメラを「上前方」へ。地形は +X 右 / -Z 上方向（=画面上）/ +Y 高さ。
  // カメラを +Z 側＆+Y 側に置き、原点を見る。
  const camDist = 2.0;
  cam.position.set(0, camDist * Math.sin(pitchRad), camDist * Math.cos(pitchRad));
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);

  renderer.render(scene, cam);

  // renderer の domElement から 2D canvas へ転写（renderer は使い回すため domElement を返さない）。
  const ctx = outCanvas.getContext("2d");
  if (ctx) ctx.drawImage(renderer.domElement, 0, 0, size, size);
  } finally {
    // 後片付け。renderer は共有なので dispose しない（次回の呼び出しで再利用）。
    for (const o of disposables) {
      try { o.dispose(); } catch { /* 既に dispose 済みなど */ }
    }
  }

  return {
    canvas: outCanvas,
    mountain: stampMountain,
    effectiveHeadingDeg: oriented ? headingDeg : 0,
    oriented,
  };
}

// 緯度経度の見やすい度分形式（例 "N 36°20.5′"）。
export function formatLatLonShort(lat: number, lon: number): string {
  const fmt = (v: number, posChar: string, negChar: string) => {
    const ch = v >= 0 ? posChar : negChar;
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = (a - d) * 60;
    return `${ch} ${d}°${m.toFixed(1)}′`;
  };
  return `${fmt(lat, "N", "S")} · ${fmt(lon, "E", "W")}`;
}

