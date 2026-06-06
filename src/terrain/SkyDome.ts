// 太陽位置に連動する空グラデーション（ドーム）。カメラ視点の背景に使う。
//
// カメラを中心にした大きな球(内側=BackSide)をシェーダで塗る。視線方向(vDir)の高度と、
// 太陽方向(uSunDir)から、昼=青/朝夕=地平の暖色/夜=暗 を作る。depthTest 無効で背景として
// 最初に描き、その上に地形・天体を重ねる。

import * as THREE from "three";

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position; // 単位球の頂点方向＝ワールド方向（回転なし）
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir; // ワールド・正規化済み

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y;                 // -1 下 .. 1 天頂
  float h = clamp(up, 0.0, 1.0);    // 0 地平 .. 1 天頂
  float sunUp = clamp(uSunDir.y, -1.0, 1.0); // 太陽高度の sin

  float day = smoothstep(-0.18, 0.12, sunUp); // 0 夜 .. 1 昼

  vec3 zenithDay = vec3(0.10, 0.30, 0.62);
  vec3 horizonDay = vec3(0.60, 0.75, 0.90);
  vec3 zenithNight = vec3(0.012, 0.02, 0.05);
  vec3 horizonNight = vec3(0.04, 0.06, 0.13);
  vec3 zenith = mix(zenithNight, zenithDay, day);
  vec3 horizon = mix(horizonNight, horizonDay, day);

  vec3 col = mix(horizon, zenith, pow(h, 0.55));

  // 朝夕焼け: 太陽が地平付近のとき、太陽方位側の地平を暖色に。
  float sunDot = max(dot(dir, uSunDir), 0.0);
  float lowSun = smoothstep(0.35, -0.06, abs(sunUp));  // 太陽が地平線付近で1
  float nearHorizon = 1.0 - smoothstep(0.0, 0.45, h);  // 地平付近で1
  vec3 warm = vec3(1.0, 0.42, 0.16);
  col = mix(col, warm, lowSun * nearHorizon * (0.25 + 0.75 * pow(sunDot, 1.5)));

  // 太陽周りのハロ（広い暖色＋締まった芯）。昼ほど強い。
  float halo = pow(sunDot, 8.0) * 0.22 + pow(sunDot, 220.0) * 0.8;
  col += max(day, 0.15) * vec3(1.0, 0.86, 0.62) * halo;

  // 地平線下はやや暗く落とす（下半球が明るすぎないように）。
  col *= mix(0.55, 1.0, smoothstep(-0.25, 0.0, up));

  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private uSunDir = { value: new THREE.Vector3(0, 1, 0) };

  constructor() {
    const geo = new THREE.SphereGeometry(1, 48, 24);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uSunDir: this.uSunDir },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1000; // 背景として最初に描く
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  /** 太陽方向(ワールド)を設定。地平線下(負のy)でも可（夜空になる）。 */
  setSunDir(d: THREE.Vector3): void {
    this.uSunDir.value.copy(d).normalize();
  }

  /** カメラ位置に追従させる（常にカメラを内包）。 */
  place(camPos: THREE.Vector3): void {
    this.mesh.position.copy(camPos);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
