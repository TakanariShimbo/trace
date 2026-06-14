// 一覧カード用サムネの「生成専用」隠しハーネス（ルート #/__thumbs）。
// 1つの WebGLRenderer / QuadtreeTerrain を使い回し、window.__renderThumb(lat,lon,elevM)
// で山頂を南東やや上から見た“斜めの静止画”(webp dataURL)を返す。
// 本番表示には使わず、scripts でまとめてキャプチャ→ public/thumbs に保存する。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { QuadtreeTerrain } from "../terrain/QuadtreeTerrain";
import { elevToWorldY, lonToMercX, latToMercY, mercXToWorld, mercYToWorld } from "../lib/mercator";

const W = 480;
const H = 270; // 16:9（カードのサムネ用。小さめで十分・軽量）

export default function ThumbStudio() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mount = ref.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0d12);
    scene.fog = new THREE.Fog(0x0a0d12, 2200, 7200);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.15);
    sun.position.set(0.6, 1, 0.4).normalize().multiplyScalar(1000);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(48, W / H, 0.05, 20000);
    const terrain = new QuadtreeTerrain(renderer);
    scene.add(terrain.group);

    // 山頂を南東やや上から望む“肖像”。順光（太陽は東〜南上）で陰影が出る向き。
    const renderThumb = (lat: number, lon: number, elevM: number) =>
      new Promise<string>((resolve, reject) => {
        const tx = mercXToWorld(lonToMercX(lon));
        const tz = mercYToWorld(latToMercY(lat));
        const ty = elevToWorldY(Math.max(0, elevM - 250));
        const target = new THREE.Vector3(tx, ty, tz);
        // カメラ距離は山の高さにほぼ比例（低い山ほど寄る）。
        // 旧式は基準が大きく、低山を引きで撮りすぎて点のようになっていた。
        // ただし起伏の小さい低山は寄りすぎると“ボケた地面”になるため下限(4.0)で止める。
        const R = Math.max(4.0, 1.4 + (elevM / 3800) * 9.3);
        const camH = elevToWorldY(elevM) + R * 0.42;
        const az = Math.PI * 0.27;
        const place = () => {
          camera.position.set(target.x + Math.cos(az) * R, camH, target.z + Math.sin(az) * R);
          camera.lookAt(target);
        };
        let frames = 0;
        let settled = 0;
        // 1枚が固まっても全体を止めないための安全装置。完了/失敗どちらでも1回だけ確定する。
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fn();
        };
        // タイル読込やWebGLが詰まって永久ハングするのを防ぐ壁時計タイムアウト（rAFが止まっても発火）。
        const timer = setTimeout(() => finish(() => reject(new Error("render timeout"))), 45000);
        const tick = () => {
          if (done) return;
          try {
            place();
            // 近接撮影でも地形のディテールが出るよう LOD を細かめに（実描画より大きい画面高を渡す）。
            // 粗いと近接時に“平坦な緑のベタ塗り”になってしまうため、細かいタイルを要求して読み込みを待つ。
            // 値は調整用に window.__thumbLOD で上書き可能。
            const lod = (window as unknown as { __thumbLOD?: number }).__thumbLOD || 330;
            terrain.update(camera, lod, camera.position.distanceTo(target));
            renderer.render(scene, camera);
            frames++;
            const s = terrain.getStats();
            if (s.loading === 0 && s.queued === 0 && frames > 16) settled++;
            else settled = 0;
            // タイルが落ち着いて数フレーム描けたら確定。細タイルの読込を待てるよう上限は長め。
            if (settled >= 4 || frames > 360) {
              place();
              renderer.render(scene, camera);
              const url = renderer.domElement.toDataURL("image/webp", 0.78);
              finish(() => resolve(url));
            } else {
              requestAnimationFrame(tick);
            }
          } catch (e) {
            // 描画例外（WebGLコンテキスト喪失など）は即失敗にして次へ。
            finish(() => reject(e instanceof Error ? e : new Error(String(e))));
          }
        };
        requestAnimationFrame(tick);
      });

    (window as unknown as { __renderThumb?: typeof renderThumb }).__renderThumb = renderThumb;
    (window as unknown as { __thumbReady?: boolean }).__thumbReady = true;

    return () => {
      const w = window as unknown as { __renderThumb?: unknown; __thumbReady?: unknown };
      delete w.__renderThumb;
      delete w.__thumbReady;
      terrain.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={ref} style={{ position: "fixed", inset: 0, background: "#0a0d12" }} />;
}
