// 太陽・月の天球オーバーレイ。観測点を中心にドームを置き、方位・高度で太陽月を配置、
// ±数時間の軌跡弧を描く。mount-photo-sim の Debug3D 天球描画を本アプリ座標系に移植。
//
// 座標系: X=東 / Y=上 / Z=南（北=-Z）。方位az(0=北,90=東)・高度alt(0=地平,90=天頂)。
// グループは観測点world位置に置き、scale で実寸化（bodies はローカル半径 BASE_R に配置）。
// 月はレイヤ1に置き、太陽方向の平行光だけで照らして満ち欠けを再現する。

import * as THREE from "three";
import type { SkyState, SkyBody } from "../lib/celestial";

const BASE_R = 100; // ローカル半径（group.scale で実寸へ）
const SUN_COLOR = 0xffe08a;
const MOON_COLOR = 0xc9d3e2;

/** 方位az・高度alt（度）→ 単位方向ベクトル（X=東, Y=上, Z=南で北=-Z）。 */
function dirFromAzAlt(azDeg: number, altDeg: number): THREE.Vector3 {
  const a = (azDeg * Math.PI) / 180;
  const e = (altDeg * Math.PI) / 180;
  return new THREE.Vector3(
    Math.cos(e) * Math.sin(a),
    Math.sin(e),
    -Math.cos(e) * Math.cos(a),
  );
}

export class CelestialLayer {
  readonly group = new THREE.Group();
  private bodies = new THREE.Group();
  private tracks = new THREE.Group();
  private moonLight: THREE.DirectionalLight;
  private horizon: THREE.LineLoop;

  constructor() {
    this.group.visible = false;

    // 月相用ライト（レイヤ1）: 月だけを太陽方向から照らす。地形(レイヤ0)には影響しない。
    this.moonLight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.moonLight.layers.set(1);
    const moonAmbient = new THREE.AmbientLight(0x6b7488, 0.4);
    moonAmbient.layers.set(1);
    this.group.add(this.moonLight, moonAmbient, this.bodies, this.tracks);

    // 地平線リング（ローカル y=0 平面・半径 BASE_R）。
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      ring.push(new THREE.Vector3(Math.cos(t) * BASE_R, 0, Math.sin(t) * BASE_R));
    }
    this.horizon = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({ color: 0x46566e, transparent: true, opacity: 0.45, fog: false }),
    );
    this.group.add(this.horizon);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** 地平線リングの表示切替（カメラ視点では隠す）。 */
  setHorizonVisible(v: boolean): void {
    this.horizon.visible = v;
  }

  /** 観測点(world)を中心に置き、ドーム半径(ワールド)でスケール。毎フレーム呼ぶ。 */
  place(center: THREE.Vector3, radiusWorld: number): void {
    this.group.position.copy(center);
    this.group.scale.setScalar(radiusWorld / BASE_R);
  }

  /** sky・軌跡を反映。日時/観測点が変わった時だけ呼べばよい。 */
  setSky(sky: SkyState | null, sunTrack: SkyBody[], moonTrack: SkyBody[]): void {
    this.clearGroup(this.bodies);
    this.clearGroup(this.tracks);
    if (!sky) return;

    // 太陽（自発光ディスク＋淡いグロー）。
    if (sky.sun.visible) {
      const sun = new THREE.Mesh(
        new THREE.SphereGeometry(4.5, 24, 16),
        new THREE.MeshBasicMaterial({ color: SUN_COLOR, fog: false }),
      );
      sun.position.copy(dirFromAzAlt(sky.sun.azimuthDeg, sky.sun.altitudeDeg)).multiplyScalar(BASE_R);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(7.5, 24, 16),
        new THREE.MeshBasicMaterial({ color: SUN_COLOR, transparent: true, opacity: 0.22, fog: false }),
      );
      glow.position.copy(sun.position);
      this.bodies.add(sun, glow);
    }

    // 月（レイヤ1・太陽方向からの平行光で満ち欠け）。
    if (sky.moon.visible) {
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(5, 28, 20),
        new THREE.MeshStandardMaterial({
          color: MOON_COLOR,
          roughness: 1,
          metalness: 0,
          transparent: true,
          opacity: 0.95,
          fog: false,
        }),
      );
      moon.layers.set(1);
      moon.position.copy(dirFromAzAlt(sky.moon.azimuthDeg, sky.moon.altitudeDeg)).multiplyScalar(BASE_R);
      this.bodies.add(moon);
    }
    // 月ライトは常に太陽方向から（方向＝平行光）。昼夜問わず正しい満ち欠けになる。
    this.moonLight.position
      .copy(dirFromAzAlt(sky.sun.azimuthDeg, sky.sun.altitudeDeg))
      .multiplyScalar(BASE_R * 2);

    // 軌跡（過去→未来の明度グラデーション）。
    this.addTrack(sunTrack, 0xffce6a);
    this.addTrack(moonTrack, 0xc8d6e6);
  }

  private addTrack(track: SkyBody[], color: number): void {
    const n = track.length;
    if (n < 2) return;
    const tmp = new THREE.Color();
    let pts: THREE.Vector3[] = [];
    let ts: number[] = [];
    const flush = () => {
      if (pts.length > 1) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const cols = new Float32Array(pts.length * 3);
        for (let k = 0; k < pts.length; k++) {
          tmp.set(color).multiplyScalar(0.15 + 0.85 * ts[k]);
          cols[k * 3] = tmp.r;
          cols[k * 3 + 1] = tmp.g;
          cols[k * 3 + 2] = tmp.b;
        }
        geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
        const line = new THREE.Line(
          geo,
          new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 2.5, gapSize: 2.5, transparent: true, fog: false }),
        );
        line.computeLineDistances();
        this.tracks.add(line);
      }
      pts = [];
      ts = [];
    };
    for (let i = 0; i < n; i++) {
      const b = track[i];
      if (b.altitudeDeg > -2) {
        pts.push(dirFromAzAlt(b.azimuthDeg, b.altitudeDeg).multiplyScalar(BASE_R));
        ts.push(i / (n - 1));
      } else {
        flush();
      }
    }
    flush();
  }

  private clearGroup(g: THREE.Group): void {
    for (const o of g.children) {
      const mesh = o as THREE.Mesh | THREE.Line;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose?.();
    }
    g.clear();
  }

  dispose(): void {
    this.clearGroup(this.bodies);
    this.clearGroup(this.tracks);
  }
}
