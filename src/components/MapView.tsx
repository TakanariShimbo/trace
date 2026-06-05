import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { QuadtreeTerrain, type TerrainStats } from "../terrain/QuadtreeTerrain";
import { worldToLonLat } from "../lib/mercator";
import { clearTileCaches } from "../lib/aerialTiles";
import {
  planPrefetch,
  runPrefetch,
  formatBytes,
  type BBox,
  type PrefetchProgress,
} from "../lib/prefetch";

// 3Dビュー本体。Three.js のセットアップ、地図的なカメラ操作（MapControls＋画面ボタン）、
// 毎フレームのクアッドツリー更新、そして事前ロード（オフライン保存）UI を持つ。

// 画面ボタンで保持する操作状態（押している間 1/-1、毎フレーム適用）。
type Nav = {
  panX: number;
  panZ: number;
  orbit: number;
  tilt: number;
  dolly: number;
  home: boolean;
};
type NavNumKey = "panX" | "panZ" | "orbit" | "tilt" | "dolly";

// 1フレームあたりの操作量。
const PAN_SPEED = 0.015;
const ORBIT_SPEED = 0.025;
const TILT_SPEED = 0.022;
const DOLLY_BASE = 1.04;

// 事前ロードで選べる最大ズーム（DEMは z14 まで、航空写真はそれ以上も高精細化）。
const PREFETCH_Z_MIN = 12;
const PREFETCH_Z_MAX = 16;
const PREFETCH_Z_DEFAULT = 14;

export default function MapView() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [stats, setStats] = useState<TerrainStats | null>(null);
  // 画面ボタンとレンダリングループで共有する操作状態（.current は callback/effect 内でのみ触る）。
  const navRef = useRef<Nav>({ panX: 0, panZ: 0, orbit: 0, tilt: 0, dolly: 0, home: false });
  // effect 内で作る「現在の表示範囲を返す」関数の橋渡し。
  const apiRef = useRef<{ getViewBounds: () => BBox | null } | null>(null);

  // --- 事前ロード（オフライン保存）UI の状態 --- //
  const [panelOpen, setPanelOpen] = useState(false);
  const [maxZ, setMaxZ] = useState(PREFETCH_Z_DEFAULT);
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [progress, setProgress] = useState<PrefetchProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [storageUsage, setStorageUsage] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 選択中の範囲＋詳細度からダウンロード計画（タイル数・サイズ目安）を作る。
  const plan = useMemo(() => (bbox ? planPrefetch(bbox, maxZ) : null), [bbox, maxZ]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const nav = navRef.current;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true, // 数km〜数千kmの広いレンジで z-fighting を防ぐ
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0d12);
    scene.fog = new THREE.Fog(0x0a0d12, 2000, 7000);

    const camera = new THREE.PerspectiveCamera(
      55,
      mount.clientWidth / mount.clientHeight,
      0.05,
      9000,
    );
    camera.position.set(0, 2200, 2600);

    const controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;
    controls.minDistance = 0.3;
    controls.maxDistance = 6000;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(0.6, 1, 0.4).normalize().multiplyScalar(1000);
    scene.add(sun);

    const terrain = new QuadtreeTerrain(renderer);
    scene.add(terrain.group);

    // --- 現在の表示範囲(bbox)を、画面四隅のレイを地表(y=0)へ落として求める --- //
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ray = new THREE.Raycaster();
    const getViewBounds = (): BBox | null => {
      const camDist = camera.position.distanceTo(controls.target);
      // 地平を向くレイが無限遠へ飛ぶのを防ぐ、地表での最大到達半径(ワールドkm)。
      const maxR = Math.min(1500, camDist * 3 + 20);
      const corners: [number, number][] = [
        [-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0],
      ];
      let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
      for (const [nx, ny] of corners) {
        ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hit = new THREE.Vector3();
        const ok = ray.ray.intersectPlane(groundPlane, hit);
        let p: THREE.Vector3;
        if (ok && hit.distanceTo(camera.position) <= maxR * 1.2) {
          p = hit;
        } else {
          p = camera.position.clone().addScaledVector(ray.ray.direction, maxR);
          p.y = 0;
        }
        // 注視点からの距離を maxR で頭打ちにして範囲を有界化。
        const dx = p.x - controls.target.x;
        const dz = p.z - controls.target.z;
        const d = Math.hypot(dx, dz);
        if (d > maxR) {
          p.x = controls.target.x + (dx * maxR) / d;
          p.z = controls.target.z + (dz * maxR) / d;
        }
        const { lat, lon } = worldToLonLat(p.x, p.z);
        latMin = Math.min(latMin, lat);
        latMax = Math.max(latMax, lat);
        lonMin = Math.min(lonMin, lon);
        lonMax = Math.max(lonMax, lon);
      }
      if (!Number.isFinite(latMin)) return null;
      return { latMin, latMax, lonMin, lonMax };
    };
    apiRef.current = { getViewBounds };

    // --- 画面ボタンによるカメラ操作（毎フレーム nav を反映） --- //
    const UP = new THREE.Vector3(0, 1, 0);
    const initPos = camera.position.clone();
    const initTarget = controls.target.clone();
    const applyNav = () => {
      if (nav.home) {
        camera.position.lerp(initPos, 0.15);
        controls.target.lerp(initTarget, 0.15);
        if (camera.position.distanceTo(initPos) < 1 && controls.target.distanceTo(initTarget) < 1) {
          camera.position.copy(initPos);
          controls.target.copy(initTarget);
          nav.home = false;
        }
        return;
      }
      if (nav.dolly) {
        const offset = camera.position.clone().sub(controls.target);
        const factor = nav.dolly > 0 ? 1 / DOLLY_BASE : DOLLY_BASE;
        const d = THREE.MathUtils.clamp(
          offset.length() * factor,
          controls.minDistance,
          controls.maxDistance,
        );
        camera.position.copy(controls.target).add(offset.setLength(d));
      }
      if (nav.orbit) {
        const offset = camera.position.clone().sub(controls.target);
        offset.applyAxisAngle(UP, ORBIT_SPEED * nav.orbit);
        camera.position.copy(controls.target).add(offset);
      }
      if (nav.tilt) {
        const offset = camera.position.clone().sub(controls.target);
        const r = offset.length();
        const az = Math.atan2(offset.x, offset.z);
        let polar = Math.acos(THREE.MathUtils.clamp(offset.y / r, -1, 1));
        polar = THREE.MathUtils.clamp(polar + TILT_SPEED * nav.tilt, 0.08, controls.maxPolarAngle);
        const sp = Math.sin(polar);
        offset.set(r * sp * Math.sin(az), r * Math.cos(polar), r * sp * Math.cos(az));
        camera.position.copy(controls.target).add(offset);
      }
      if (nav.panX || nav.panZ) {
        const step = camera.position.distanceTo(controls.target) * PAN_SPEED;
        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
        const move = new THREE.Vector3()
          .addScaledVector(forward, nav.panZ * step)
          .addScaledVector(right, nav.panX * step);
        camera.position.add(move);
        controls.target.add(move);
      }
    };

    let raf = 0;
    let statsTick = 0;
    const loop = () => {
      applyNav();
      controls.update();
      const camDist = camera.position.distanceTo(controls.target);
      terrain.update(camera, mount.clientHeight, camDist);
      renderer.render(scene, camera);
      if (++statsTick % 20 === 0) setStats(terrain.getStats());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      apiRef.current = null;
      controls.dispose();
      terrain.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // --- 画面ボタンのプレス/リリース --- //
  const start = (patch: Partial<Nav>) => (e: React.PointerEvent) => {
    e.preventDefault();
    Object.assign(navRef.current, patch);
  };
  const stop = (...keys: NavNumKey[]) => () => {
    for (const k of keys) navRef.current[k] = 0;
  };
  const hold = (patch: Partial<Nav>, ...keys: NavNumKey[]) => ({
    onPointerDown: start(patch),
    onPointerUp: stop(...keys),
    onPointerLeave: stop(...keys),
    onPointerCancel: stop(...keys),
  });

  // --- 事前ロード操作 --- //
  const refreshStorage = () => {
    navigator.storage?.estimate?.().then((e) => setStorageUsage(e.usage ?? 0));
  };
  const openPanel = () => {
    setPanelOpen(true);
    refreshStorage();
  };
  const captureView = () => {
    setBbox(apiRef.current?.getViewBounds() ?? null);
  };
  const startDownload = async () => {
    if (!plan || plan.jobs.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setProgress({ done: 0, total: plan.jobs.length, failed: 0 });
    await runPrefetch(plan, setProgress, controller.signal);
    setDownloading(false);
    abortRef.current = null;
    refreshStorage();
  };
  const cancelDownload = () => abortRef.current?.abort();
  const clearCache = async () => {
    await clearTileCaches();
    setProgress(null);
    refreshStorage();
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="mapview">
      <div className="mapview-canvas" ref={mountRef} />
      {stats && (
        <div className="hud">
          <span>tiles {stats.loaded}</span>
          <span>load {stats.loading}</span>
          <span>queue {stats.queued}</span>
          <span>draw {stats.visible}</span>
        </div>
      )}

      {/* オフライン保存パネルを開くボタン（右上） */}
      <button className="save-open" title="オフライン保存（事前ロード）" onClick={openPanel}>
        ⤓ 保存
      </button>

      {/* カメラ操作ボタン（右下） */}
      <div className="nav-controls">
        <div className="nav-row">
          <button className="nav-btn" title="水平に近づける" {...hold({ tilt: 1 }, "tilt")}>
            <span className="nav-ico nav-ico--tilt-up" />
          </button>
          <button className="nav-btn" title="見下ろす" {...hold({ tilt: -1 }, "tilt")}>
            <span className="nav-ico nav-ico--tilt-down" />
          </button>
        </div>
        <div className="nav-row">
          <button className="nav-btn" title="左に回す" {...hold({ orbit: 1 }, "orbit")}>↺</button>
          <button className="nav-btn" title="右に回す" {...hold({ orbit: -1 }, "orbit")}>↻</button>
        </div>
        <div className="nav-pad">
          <button className="nav-btn nav-up" title="前へ" {...hold({ panZ: 1 }, "panZ")}>▲</button>
          <button className="nav-btn nav-left" title="左へ" {...hold({ panX: -1 }, "panX")}>◀</button>
          <button
            className="nav-btn nav-home"
            title="日本全体に戻す"
            onClick={() => {
              navRef.current.home = true;
            }}
          >
            ⌂
          </button>
          <button className="nav-btn nav-right" title="右へ" {...hold({ panX: 1 }, "panX")}>▶</button>
          <button className="nav-btn nav-down" title="後ろへ" {...hold({ panZ: -1 }, "panZ")}>▼</button>
        </div>
        <div className="nav-zoom">
          <button className="nav-btn" title="ズームイン" {...hold({ dolly: 1 }, "dolly")}>＋</button>
          <button className="nav-btn" title="ズームアウト" {...hold({ dolly: -1 }, "dolly")}>−</button>
        </div>
      </div>

      {/* オフライン保存パネル */}
      {panelOpen && (
        <div className="save-panel">
          <div className="save-head">
            <span>オフライン保存</span>
            <button className="save-close" title="閉じる" onClick={() => setPanelOpen(false)}>×</button>
          </div>

          <p className="save-note">
            いま画面に写っている範囲を、選んだ詳細度までダウンロードして保存します。
            保存後は通信なしでもその範囲を3D表示できます。
          </p>

          <label className="save-field">
            <span>最大ズーム（詳細度）: z{maxZ}{maxZ > 14 ? "（標高は z14 まで）" : ""}</span>
            <input
              type="range"
              min={PREFETCH_Z_MIN}
              max={PREFETCH_Z_MAX}
              value={maxZ}
              disabled={downloading}
              onChange={(e) => setMaxZ(Number(e.target.value))}
            />
          </label>

          <button className="save-btn" onClick={captureView} disabled={downloading}>
            現在の表示範囲を対象にする
          </button>

          {plan && (
            <div className="save-plan">
              {plan.jobs.length === 0 ? (
                <span className="save-warn">この範囲は日本の範囲外です。</span>
              ) : (
                <>
                  <div>
                    タイル数: <b>{plan.jobs.length.toLocaleString()}</b>（航空写真 {plan.aerialCount.toLocaleString()} ＋ 標高 {plan.demCount.toLocaleString()}）
                  </div>
                  <div>サイズ目安: 約 {formatBytes(plan.estBytes)}</div>
                  {plan.truncated && (
                    <div className="save-warn">範囲が広すぎるため上限で打ち切りました。ズームインして範囲を絞ってください。</div>
                  )}
                </>
              )}
            </div>
          )}

          {downloading && progress && (
            <div className="save-progress">
              <div className="save-bar">
                <div className="save-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="save-prog-text">
                {progress.done.toLocaleString()} / {progress.total.toLocaleString()}（{pct}%）
                {progress.failed > 0 && ` ／ 失敗 ${progress.failed}`}
              </div>
            </div>
          )}

          <div className="save-actions">
            {downloading ? (
              <button className="save-btn save-btn--danger" onClick={cancelDownload}>中止</button>
            ) : (
              <button
                className="save-btn save-btn--primary"
                onClick={startDownload}
                disabled={!plan || plan.jobs.length === 0}
              >
                ダウンロード
              </button>
            )}
          </div>

          <div className="save-storage">
            <span>保存済み: {storageUsage == null ? "—" : formatBytes(storageUsage)}</span>
            <button className="save-link" onClick={clearCache} disabled={downloading}>
              キャッシュを削除
            </button>
          </div>
        </div>
      )}

      <div className="attribution">地図・航空写真・標高: 国土地理院（GSI）タイル</div>
    </div>
  );
}
