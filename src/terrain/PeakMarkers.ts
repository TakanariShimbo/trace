// 山頂マーカー。全山頂（mountains.json）にオレンジの点を置き、タップ／クリックで選択した
// 山だけ色を変える（複数選択可・選択は青）。山名ラベルは全山に表示し、選択した山は青で
// 強調する（ラベルは MapView 側で DOM 描画）。カメラ視点では選択した山だけ残す。
//
// 座標系: X=東 / Y=上 / Z=南（mercator.ts と一致）。点サイズは sizeAttenuation:false で
// 画面ピクセル固定。depthTest:false で常に地形の上に描き、地形の裏の山頂もタップできる。
// 当たり判定は world→画面へ投影してクリック位置に最も近い点を選ぶスクリーン空間方式。

import * as THREE from "three";
import type { MountainHit } from "../lib/mountains";
import { mercXToWorld, mercYToWorld, elevToWorldY, lonToMercX, latToMercY } from "../lib/mercator";

const COL_BASE = new THREE.Color(0xff9e3d); // 非選択（オレンジ。地形に埋もれず派手すぎない）
const COL_SELECTED = new THREE.Color(0x5b9cf0); // 選択中（アプリのアクセントに合わせたブルー）
const POINT_PX = 7; // 点の画面サイズ(px)
const PICK_RADIUS_PX = 16; // この画素以内のクリックを「その点をタップ」とみなす

/** 丸い点スプライト用の小さな放射状グラデーションテクスチャ。 */
function makeDotTexture(): THREE.Texture {
  const s = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.6, "rgba(255,255,255,1)");
  g.addColorStop(0.85, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

export class PeakMarkers {
  readonly points: THREE.Points;
  readonly selected = new Set<number>();
  private geom = new THREE.BufferGeometry();
  private mat: THREE.PointsMaterial;
  private peaks: MountainHit[] = [];
  // 各山頂のワールド位置（Y は現在の VEX を反映）。投影・ラベル配置に使う。
  private world: THREE.Vector3[] = [];
  private elevM: number[] = []; // VEX 変更時に Y を再計算するための素の標高
  private colors!: Float32Array; // RGBA（アルファで未選択点の表示/非表示を制御）
  private hideUnselected = false; // カメラビュー時 true＝未選択(グレー)は隠し、選択(青)だけ出す
  // 円盤クリップ（太陽・月モードで地形を丸く切り抜く際、外側の点・ラベルも隠す）。
  private clipActive = false;
  private clipX = 0;
  private clipZ = 0;
  private clipR2 = 0;
  private tmp = new THREE.Vector3();

  constructor() {
    this.mat = new THREE.PointsMaterial({
      size: POINT_PX,
      sizeAttenuation: false,
      map: makeDotTexture(),
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(this.geom, this.mat);
    this.points.renderOrder = 998;
    this.points.frustumCulled = false; // 全点を常に描く（色で選択を表す）
    this.points.visible = false;
  }

  setVisible(v: boolean): void {
    this.points.visible = v;
  }

  get hasData(): boolean {
    return this.peaks.length > 0;
  }

  get selectedCount(): number {
    return this.selected.size;
  }

  /** 山頂の総数（ラベル生成・走査に使う）。 */
  get count(): number {
    return this.peaks.length;
  }

  peakName(i: number): string {
    return this.peaks[i]?.name ?? "";
  }

  /** 山頂 i の山ID（mountains.json の id）。解説の引き当てに使う。 */
  peakId(i: number): number {
    return this.peaks[i]?.id ?? -1;
  }

  /** 山頂 i の標高(m)。書き出しのラベル「山名＋標高」に使う。 */
  peakElev(i: number): number {
    return this.elevM[i] ?? 0;
  }

  /** 山頂 i のワールド座標（Y は現在の VEX 反映済み）。ラベル投影に使う。 */
  worldPos(i: number): THREE.Vector3 {
    return this.world[i];
  }

  isSelected(i: number): boolean {
    return this.selected.has(i);
  }

  /** 山頂データを流し込み、ジオメトリを構築。最初の有効化時に一度だけ呼べばよい。 */
  setData(peaks: MountainHit[]): void {
    this.peaks = peaks;
    this.selected.clear();
    const n = peaks.length;
    const pos = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 4); // RGBA
    this.world = new Array(n);
    this.elevM = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = peaks[i];
      const x = mercXToWorld(lonToMercX(p.lon));
      const z = mercYToWorld(latToMercY(p.lat));
      const y = elevToWorldY(p.elevationM);
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      this.world[i] = new THREE.Vector3(x, y, z);
      this.elevM[i] = p.elevationM;
      this.writeColor(i);
    }
    this.geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geom.setAttribute("color", new THREE.BufferAttribute(this.colors, 4)); // itemSize 4 で頂点アルファ有効
    this.geom.attributes.position.needsUpdate = true;
    this.geom.attributes.color.needsUpdate = true;
  }

  /** カメラビューモード切替。true で未選択(グレー)点を隠し、選択(青)だけ表示する。 */
  setCameraMode(on: boolean): void {
    if (this.hideUnselected === on) return;
    this.hideUnselected = on;
    if (!this.peaks.length) return;
    for (let i = 0; i < this.peaks.length; i++) this.writeColor(i);
    const attr = this.geom.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  }

  /** 円盤クリップを設定（中心・半径ワールド）。null で解除。外側の点はアルファ0で隠す。
   *  毎フレーム呼ばれるが、変化が無ければ書き換えない。 */
  setClipDisk(center: { x: number; z: number } | null, radiusWorld: number): void {
    const active = center != null;
    const cx = center ? center.x : 0;
    const cz = center ? center.z : 0;
    const r2 = radiusWorld * radiusWorld;
    if (active === this.clipActive && cx === this.clipX && cz === this.clipZ && r2 === this.clipR2) {
      return;
    }
    this.clipActive = active;
    this.clipX = cx;
    this.clipZ = cz;
    this.clipR2 = r2;
    if (!this.peaks.length) return;
    for (let i = 0; i < this.peaks.length; i++) this.writeColor(i);
    const attr = this.geom.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  }

  /** 円盤クリップで隠れる山頂か（ラベル側の表示判定にも使う）。 */
  isHiddenByClip(i: number): boolean {
    if (!this.clipActive) return false;
    const w = this.world[i];
    const dx = w.x - this.clipX;
    const dz = w.z - this.clipZ;
    return dx * dx + dz * dz > this.clipR2;
  }

  /** colors[i] を選択状態とモードに応じて RGBA で書き込む（needsUpdate は呼び出し側）。 */
  private writeColor(i: number): void {
    const sel = this.selected.has(i);
    const c = sel ? COL_SELECTED : COL_BASE;
    let a = sel ? 1 : this.hideUnselected ? 0 : 1; // 未選択はカメラビューで透明
    if (a > 0 && this.isHiddenByClip(i)) a = 0; // 円盤クリップの外は隠す
    const o = i * 4;
    this.colors[o] = c.r;
    this.colors[o + 1] = c.g;
    this.colors[o + 2] = c.b;
    this.colors[o + 3] = a;
  }

  /** VEX 変更時に各山頂の Y（とジオメトリ）を再計算。 */
  refreshY(): void {
    if (!this.peaks.length) return;
    const posAttr = this.geom.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.peaks.length; i++) {
      const y = elevToWorldY(this.elevM[i]);
      posAttr.setY(i, y);
      this.world[i].y = y;
    }
    posAttr.needsUpdate = true;
  }

  /**
   * 画面座標(px)に最も近い山頂の index を返す（PICK_RADIUS_PX 以内）。なければ null。
   * world→NDC へ投影し、画面ピクセル距離で最近傍を探すスクリーン空間ピッキング。
   */
  pick(px: number, py: number, camera: THREE.Camera, w: number, h: number): number | null {
    if (!this.peaks.length) return null;
    let best = -1;
    let bestD = PICK_RADIUS_PX * PICK_RADIUS_PX;
    for (let i = 0; i < this.world.length; i++) {
      const v = this.tmp.copy(this.world[i]).project(camera);
      if (v.z > 1) continue; // カメラ後方
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      const dx = sx - px;
      const dy = sy - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }

  /** index の選択状態を反転。選択中になったら true。 */
  toggle(i: number): boolean {
    const on = !this.selected.has(i);
    if (on) this.selected.add(i);
    else this.selected.delete(i);
    this.writeColor(i);
    const attr = this.geom.getAttribute("color") as THREE.BufferAttribute;
    attr.needsUpdate = true;
    return on;
  }

  /** 全選択を解除してグレーに戻す。 */
  clearSelection(): void {
    const prev = [...this.selected];
    this.selected.clear();
    for (const i of prev) this.writeColor(i);
    const attr = this.geom.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.mat.map?.dispose();
    this.mat.dispose();
  }
}
