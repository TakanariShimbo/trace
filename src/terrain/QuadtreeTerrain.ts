// クアッドツリー方式のストリーミング3D地形（Google Earth風 LOD）。
//
// 仕組み（Cesium/Google Earth と同じ系統）:
//   - 地形を XYZ タイルのクアッドツリーで表す。各タイル = 1枚の DEMメッシュ + 航空写真。
//   - 毎フレーム、カメラから見たタイルの「画面上の大きさ(px)」を見積もり、
//     大きすぎるタイルは4分割（=ズームイン）、小さくなれば親に戻す（=統合）。
//   - 視錐台の外のタイルは描画しない（フラスタムカリング、少し外側まで先読み）。
//   - タイルの DEM/航空写真は非同期ロード。子が揃うまでは親を表示し、揃ったら一斉に
//     差し替える（常に隙間なく何かが描かれる＝プログレッシブ詳細化）。
//
// 日本に限定: ルートタイルを日本のbboxに重なる z5 タイルだけにする。範囲外はロードしない。

import * as THREE from "three";
import {
  type TileId,
  tileMercBounds,
  mercXToWorld,
  mercYToWorld,
  elevToWorldY,
  lonLatToTile,
  JAPAN_BBOX,
} from "../lib/mercator";
import { sampleTile } from "../workers/terrainClient";
import { fetchBasemapTile, DEFAULT_BASEMAP, type Basemap } from "../lib/basemaps";

// --- チューニング定数 --- //
const MIN_ZOOM = 5; // ルート（日本全体がこの粒度のタイル群で覆われる）
const MAX_ZOOM = 16; // 最大詳細（z16 ≒ 約2.4m/px。全ベースマップが z16 以上に対応）
const GRID_N = 32; // 1タイルの格子分割数（頂点は 33x33）
const SPLIT_PX = 384; // 画面上でこの px を超えるタイルは分割
const MAX_CONCURRENT_LOADS = 6;
const PRUNE_INTERVAL = 60; // 何フレームごとに未使用タイルを掃除するか
const PRUNE_AGE = 300; // この数フレーム未使用なら mesh を破棄
const ELEV_MIN_GUESS = -50; // 未ロード時のAABB下限(m)
const ELEV_MAX_GUESS = 4000; // 未ロード時のAABB上限(m, 富士山+余裕)
const OCEAN_COLOR = 0x12304a;

const JP = JAPAN_BBOX;

type TileState = "empty" | "loading" | "ready" | "failed";

class Tile {
  z: number;
  x: number;
  y: number;
  parent: Tile | null;
  children: Tile[] | null = null;
  mesh: THREE.Mesh | null = null;
  state: TileState = "empty";
  lastUsedFrame = 0;

  // ワールドAABB（水平は確定、Yはロード後に実値へ）。
  box: THREE.Box3;
  worldSize: number; // 水平方向の最大辺（screen-space誤差の算出に使う）

  constructor(id: TileId, parent: Tile | null) {
    this.z = id.z;
    this.x = id.x;
    this.y = id.y;
    this.parent = parent;
    const b = tileMercBounds(id.z, id.x, id.y);
    const x0 = mercXToWorld(b.mxMin);
    const x1 = mercXToWorld(b.mxMax);
    const z0 = mercYToWorld(b.myMin); // 南
    const z1 = mercYToWorld(b.myMax); // 北
    this.worldSize = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
    this.box = new THREE.Box3(
      new THREE.Vector3(Math.min(x0, x1), elevToWorldY(ELEV_MIN_GUESS), Math.min(z0, z1)),
      new THREE.Vector3(Math.max(x0, x1), elevToWorldY(ELEV_MAX_GUESS), Math.max(z0, z1)),
    );
  }

  ensureChildren(): Tile[] {
    if (this.children) return this.children;
    const { z, x, y } = this;
    this.children = [
      new Tile({ z: z + 1, x: x * 2, y: y * 2 }, this),
      new Tile({ z: z + 1, x: x * 2 + 1, y: y * 2 }, this),
      new Tile({ z: z + 1, x: x * 2, y: y * 2 + 1 }, this),
      new Tile({ z: z + 1, x: x * 2 + 1, y: y * 2 + 1 }, this),
    ];
    return this.children;
  }
}

export type TerrainStats = {
  loaded: number;
  loading: number;
  queued: number;
  visible: number;
};

export class QuadtreeTerrain {
  readonly group = new THREE.Group();
  private roots: Tile[] = [];
  private frame = 0;
  private active = 0;
  private maxAniso: number;
  // 円盤クリップ用の共有ユニフォーム（全タイル材質が参照）。
  // on=1 のとき、観測点 center から半径 radius(ワールド) の円の外側フラグメントを捨てる。
  private clip = {
    on: { value: 0 },
    center: { value: new THREE.Vector2() },
    radius: { value: 0 },
  };
  // 現在ドレープしているベースマップ。setBasemap で切替（タイルを貼り直す）。
  private basemap: Basemap;
  // ベースマップ世代。切替時に +1 し、古い世代の読込結果は捨てる。
  private gen = 0;
  // ロード待ち（優先度＝画面上の大きさ。大きいタイルを先に）。
  private pending = new Map<Tile, number>();
  // 現在表示中のメッシュを持つタイル（フレーム差分で hide する）。
  private shown = new Set<Tile>();
  private newShown = new Set<Tile>();
  private allTiles = new Set<Tile>();

  constructor(renderer: THREE.WebGLRenderer, basemap: Basemap = DEFAULT_BASEMAP) {
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.basemap = basemap;
    this.buildRoots();
    // ルートを先読みして起動直後の空白を短くする。
    for (const r of this.roots) this.requestLoad(r, Infinity);
    this.pump();
  }

  /** ベースマップを切替。全タイルのテクスチャを貼り直す（メッシュ破棄→再ロード）。 */
  setBasemap(basemap: Basemap): void {
    if (basemap.id === this.basemap.id) return;
    this.basemap = basemap;
    this.gen++;
    this.pending.clear();
    this.shown.clear();
    for (const t of this.allTiles) {
      if (t.mesh) this.disposeMesh(t);
      if (t.state !== "loading") t.state = "empty"; // 読込中は世代チェックで弾く
    }
    for (const r of this.roots) this.requestLoad(r, Infinity);
    this.pump();
  }

  private buildRoots(): void {
    const nw = lonLatToTile(JP.latMax, JP.lonMin, MIN_ZOOM);
    const se = lonLatToTile(JP.latMin, JP.lonMax, MIN_ZOOM);
    for (let x = nw.x; x <= se.x; x++) {
      for (let y = nw.y; y <= se.y; y++) {
        const t = new Tile({ z: MIN_ZOOM, x, y }, null);
        this.roots.push(t);
        this.allTiles.add(t);
      }
    }
  }

  /** 毎フレーム呼ぶ。LOD選択→可視性更新→ロードキュー処理。 */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number, camTargetDist: number): void {
    this.frame++;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    // 視野の少し外まで先読みして、パン時の隙間を減らす。
    const margin = Math.max(1, camTargetDist * 0.1);
    for (const p of frustum.planes) p.constant += margin;

    // px/world の係数（worldSize/距離 を画面pxへ）。
    const fovScale = viewportHeightPx / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const camPos = camera.position;

    this.newShown.clear();
    for (const r of this.roots) this.refine(r, frustum, camPos, fovScale);

    // 前フレーム表示で今フレーム非選択のメッシュを隠す。
    for (const t of this.shown) {
      if (!this.newShown.has(t) && t.mesh) t.mesh.visible = false;
    }
    const tmp = this.shown;
    this.shown = this.newShown;
    this.newShown = tmp;

    this.pump();
    if (this.frame % PRUNE_INTERVAL === 0) this.prune();
  }

  private screenPx(tile: Tile, camPos: THREE.Vector3, fovScale: number): number {
    // カメラからタイルAABB最近点までの距離。
    const c = tile.box.clampPoint(camPos, new THREE.Vector3());
    const d = camPos.distanceTo(c);
    if (d < 1e-3) return Infinity;
    return (tile.worldSize / d) * fovScale;
  }

  private refine(
    tile: Tile,
    frustum: THREE.Frustum,
    camPos: THREE.Vector3,
    fovScale: number,
  ): void {
    if (!frustum.intersectsBox(tile.box)) return; // 視錐台外＝描画しない（＝この領域は空ける）
    // 円盤クリップ中もタイルのロード/LODは通常と一切変えない（タイル単位カリングはしない）。
    // 円の見た目はマテリアル側のピクセル単位 discard だけで作る → 太陽月の有無で地形挙動は同一。
    tile.lastUsedFrame = this.frame;

    const wantRefine = tile.z < MAX_ZOOM && this.screenPx(tile, camPos, fovScale) > SPLIT_PX;
    if (!wantRefine) {
      this.drawSelf(tile);
      return;
    }

    const children = tile.ensureChildren();
    for (const c of children) this.allTiles.add(c);
    // 視野内の子がすべて ready なら子へ降りる（差し替え）。視野外の子は無視。
    let swapReady = true;
    for (const c of children) {
      if (!frustum.intersectsBox(c.box)) continue;
      if (c.state !== "ready") {
        swapReady = false;
        break;
      }
    }
    if (swapReady) {
      for (const c of children) this.refine(c, frustum, camPos, fovScale);
    } else {
      // 子のロードを要求しつつ、揃うまでは親を表示（隙間を作らない）。
      const prio = this.screenPx(tile, camPos, fovScale);
      for (const c of children) {
        if (frustum.intersectsBox(c.box)) this.requestLoad(c, prio);
      }
      this.drawSelf(tile);
    }
  }

  private drawSelf(tile: Tile): void {
    if (tile.state === "ready" && tile.mesh) {
      tile.mesh.visible = true;
      this.newShown.add(tile);
    } else {
      this.requestLoad(tile, tile.worldSize); // ざっくり優先度
    }
  }

  private requestLoad(tile: Tile, priority: number): void {
    if (tile.state === "ready" || tile.state === "loading") return;
    const cur = this.pending.get(tile);
    if (cur === undefined || priority > cur) this.pending.set(tile, priority);
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_LOADS && this.pending.size > 0) {
      // 最優先（画面上で最大）のタイルを取り出す。
      let best: Tile | null = null;
      let bestP = -Infinity;
      for (const [t, p] of this.pending) {
        if (p > bestP) {
          bestP = p;
          best = t;
        }
      }
      if (!best) break;
      this.pending.delete(best);
      this.startLoad(best);
    }
  }

  private startLoad(tile: Tile): void {
    tile.state = "loading";
    this.active++;
    const gen = this.gen; // この読込が始まった時点のベースマップ世代
    Promise.all([
      sampleTile(tile.z, tile.x, tile.y, GRID_N),
      fetchBasemapTile(this.basemap, tile.z, tile.x, tile.y),
    ])
      .then(([elev, bitmap]) => {
        if (gen !== this.gen) {
          // ベースマップが切替わった後の旧世代結果は捨てて、再ロードできるようにする。
          bitmap?.close?.();
          tile.state = "empty";
          return;
        }
        const mesh = this.buildMesh(tile, elev, bitmap);
        tile.mesh = mesh;
        mesh.visible = false;
        this.group.add(mesh);
        tile.state = "ready";
      })
      .catch(() => {
        tile.state = "failed";
      })
      .finally(() => {
        this.active--;
        this.pump();
      });
  }

  private buildMesh(tile: Tile, elev: Float32Array, bitmap: ImageBitmap | null): THREE.Mesh {
    const verts = GRID_N + 1;
    const b = tileMercBounds(tile.z, tile.x, tile.y);
    const xNW = mercXToWorld(b.mxMin);
    const zNW = mercYToWorld(b.myMax); // 北
    const worldW = mercXToWorld(b.mxMax) - xNW;
    const worldD = zNW - mercYToWorld(b.myMin); // 北→南の距離(正)

    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let minY = Infinity;
    let maxY = -Infinity;

    for (let j = 0; j < verts; j++) {
      const v = j / GRID_N; // 0=北
      for (let i = 0; i < verts; i++) {
        const u = i / GRID_N; // 0=西
        const y = elevToWorldY(elev[j * verts + i]);
        pos.push(u * worldW, y, -v * worldD); // ローカル原点=NW角
        uv.push(u, v); // texture flipY=false 前提（v=0 が画像上端=北）
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    for (let j = 0; j < GRID_N; j++) {
      for (let i = 0; i < GRID_N; i++) {
        const a = j * verts + i;
        const c = j * verts + i + 1;
        const d = (j + 1) * verts + i;
        const e = (j + 1) * verts + i + 1;
        idx.push(a, d, c, c, d, e);
      }
    }

    // スカート（隣接LOD境界のひび割れ隠し）。各辺を少し下へ垂らす壁。
    const skirtDrop = Math.max(worldW, worldD) * 0.03 + 0.02;
    const edge = (arr: number[]) => {
      const start = pos.length / 3;
      for (const bi of arr) {
        pos.push(pos[bi * 3], pos[bi * 3 + 1] - skirtDrop, pos[bi * 3 + 2]);
        uv.push(uv[bi * 2], uv[bi * 2 + 1]);
      }
      for (let k = 0; k < arr.length - 1; k++) {
        const a = arr[k];
        const c = arr[k + 1];
        const a2 = start + k;
        const c2 = start + k + 1;
        idx.push(a, a2, c, c, a2, c2);
        idx.push(a, c, a2, c, c2, a2); // 両面（視点が下がっても見える）
      }
    };
    const top: number[] = [];
    const bottom: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < verts; i++) {
      top.push(i);
      bottom.push((verts - 1) * verts + i);
      left.push(i * verts);
      right.push(i * verts + (verts - 1));
    }
    edge(top);
    edge(bottom);
    edge(left);
    edge(right);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    // AABBのYを実標高で更新（カリング・距離の精度向上）。
    tile.box.min.y = minY - skirtDrop;
    tile.box.max.y = maxY;

    let material: THREE.MeshStandardMaterial;
    if (bitmap) {
      const tex = new THREE.Texture(bitmap);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.anisotropy = this.maxAniso;
      tex.needsUpdate = true;
      material = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });
    } else {
      material = new THREE.MeshStandardMaterial({
        color: OCEAN_COLOR,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });
    }

    this.applyClipShader(material);

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(xNW, 0, zNW);
    mesh.renderOrder = tile.z; // 深いタイルを後で描く（差し替え時のちらつき低減）
    return mesh;
  }

  /** 地形マテリアルに「観測点中心・半径Rの円の外側を捨てる」シェーダを注入。 */
  private applyClipShader(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uClipOn = this.clip.on;
      shader.uniforms.uClipCenter = this.clip.center;
      shader.uniforms.uClipRadius = this.clip.radius;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vClipXZ;")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n  vClipXZ = (modelMatrix * vec4(transformed, 1.0)).xz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vClipXZ;\nuniform float uClipOn;\nuniform vec2 uClipCenter;\nuniform float uClipRadius;",
        )
        .replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\n  if (uClipOn > 0.5 && distance(vClipXZ, uClipCenter) > uClipRadius) discard;",
        );
    };
  }

  /** 地形を観測点中心・半径(ワールド)の円盤に切り抜く。null で解除（全面表示）。 */
  setClip(center: { x: number; z: number } | null, radiusWorld: number): void {
    if (!center) {
      this.clip.on.value = 0;
      return;
    }
    this.clip.on.value = 1;
    this.clip.center.value.set(center.x, center.z);
    this.clip.radius.value = radiusWorld;
  }

  private prune(): void {
    for (const t of this.allTiles) {
      if (t.parent === null) continue; // ルートは残す
      if (t.mesh && t.state === "ready" && this.frame - t.lastUsedFrame > PRUNE_AGE) {
        this.disposeMesh(t);
        t.state = "empty";
      }
    }
  }

  private disposeMesh(tile: Tile): void {
    const m = tile.mesh;
    if (!m) return;
    this.group.remove(m);
    m.geometry.dispose();
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.map?.dispose();
    mat.dispose();
    tile.mesh = null;
    this.shown.delete(tile);
  }

  getStats(): TerrainStats {
    let loaded = 0;
    let loading = 0;
    for (const t of this.allTiles) {
      if (t.state === "ready") loaded++;
      else if (t.state === "loading") loading++;
    }
    return { loaded, loading, queued: this.pending.size, visible: this.shown.size };
  }

  dispose(): void {
    for (const t of this.allTiles) this.disposeMesh(t);
    this.allTiles.clear();
    this.roots = [];
    this.pending.clear();
    this.shown.clear();
  }
}
