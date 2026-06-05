import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { QuadtreeTerrain, type TerrainStats } from "../terrain/QuadtreeTerrain";
import {
  worldToLonLat,
  lonToMercX,
  latToMercY,
  mercXToWorld,
  mercYToWorld,
} from "../lib/mercator";
import {
  BASEMAPS,
  basemapById,
  clearTileCaches,
  type Basemap,
} from "../lib/basemaps";
import { runSearch, type SearchMode, type SearchResult } from "../lib/search";
import {
  planPrefetchDisk,
  runPrefetch,
  formatBytes,
  type LonLat,
  type PrefetchProgress,
} from "../lib/prefetch";

// 3Dビュー本体。Three.js のセットアップ、地図的なカメラ操作（MapControls＋画面ボタン）、
// 毎フレームのクアッドツリー更新、そして事前ロード（中心＋半径でオフライン保存）UI を持つ。

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

// 事前ロードのパラメータ範囲。
const PREFETCH_Z_MIN = 12;
const PREFETCH_Z_MAX = 16;
const PREFETCH_Z_DEFAULT = 14;
const RADIUS_MIN = 1;
const RADIUS_MAX = 50;
const RADIUS_DEFAULT = 8;

export default function MapView() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [stats, setStats] = useState<TerrainStats | null>(null);
  // 画面ボタンとレンダリングループで共有する操作状態（.current は callback/effect 内でのみ触る）。
  const navRef = useRef<Nav>({ panX: 0, panZ: 0, orbit: 0, tilt: 0, dolly: 0, home: false });
  // effect 内で作る各種カメラ/地形操作を React 側へ橋渡しする。
  const apiRef = useRef<{
    getCenter: () => LonLat | null;
    setPreview: (center: LonLat | null, radiusKm: number) => void;
    flyTo: (c: LonLat) => void;
    setBasemap: (layer: Basemap) => void;
  } | null>(null);

  // --- ベースマップ・検索の状態 --- //
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("both");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // --- 事前ロード（オフライン保存）UI の状態 --- //
  const [panelOpen, setPanelOpen] = useState(false);
  const [maxZ, setMaxZ] = useState(PREFETCH_Z_DEFAULT);
  const [radiusKm, setRadiusKm] = useState(RADIUS_DEFAULT);
  const [center, setCenter] = useState<LonLat | null>(null);
  const [progress, setProgress] = useState<PrefetchProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [storageUsage, setStorageUsage] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 中心＋半径＋詳細度＋ベースマップからダウンロード計画（タイル数・サイズ目安）を作る。
  const plan = useMemo(
    () => (center ? planPrefetchDisk(center, radiusKm, maxZ, basemapById(basemapId)) : null),
    [center, radiusKm, maxZ, basemapId],
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const nav = navRef.current;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      logarithmicDepthBuffer: true,
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

    // --- 事前ロード範囲（中心＋半径）のプレビュー円。地形に隠れないよう常に手前に描く --- //
    const ringPts: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) {
      const t = (i / 128) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(t), 0, Math.sin(t)));
    }
    const previewRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(ringPts),
      new THREE.LineBasicMaterial({ color: 0x5bd6ff, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    previewRing.renderOrder = 999;
    previewRing.visible = false;
    scene.add(previewRing);

    const getCenter = (): LonLat | null => {
      // カメラの注視点（地面上の見ている中心）を経緯度に。
      return worldToLonLat(controls.target.x, controls.target.z);
    };
    const setPreview = (c: LonLat | null, rKm: number) => {
      if (!c) {
        previewRing.visible = false;
        return;
      }
      const cx = mercXToWorld(lonToMercX(c.lon));
      const cz = mercYToWorld(latToMercY(c.lat));
      // 半径(km)→ワールド単位: 中心から rKm 北の点までのワールド距離で換算。
      const nz = mercYToWorld(latToMercY(c.lat + rKm / 111.32));
      const rWorld = Math.abs(nz - cz);
      previewRing.position.set(cx, 1, cz);
      previewRing.scale.set(rWorld, 1, rWorld);
      previewRing.visible = true;
    };

    // 指定地点へ滑らかに移動（視線方向を保ったまま一定距離まで寄る）。applyNav が補間する。
    let flyGoal: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const flyTo = (c: LonLat) => {
      const target = new THREE.Vector3(
        mercXToWorld(lonToMercX(c.lon)),
        0,
        mercYToWorld(latToMercY(c.lat)),
      );
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 1);
      dir.setLength(25); // 到達時のカメラ距離(km)
      flyGoal = { pos: target.clone().add(dir), target };
    };

    apiRef.current = {
      getCenter,
      setPreview,
      flyTo,
      setBasemap: (layer) => terrain.setBasemap(layer),
    };

    // --- 画面ボタンによるカメラ操作（毎フレーム nav を反映） --- //
    const UP = new THREE.Vector3(0, 1, 0);
    const initPos = camera.position.clone();
    const initTarget = controls.target.clone();
    const applyNav = () => {
      if (flyGoal) {
        camera.position.lerp(flyGoal.pos, 0.12);
        controls.target.lerp(flyGoal.target, 0.12);
        if (
          camera.position.distanceTo(flyGoal.pos) < 0.5 &&
          controls.target.distanceTo(flyGoal.target) < 0.5
        ) {
          camera.position.copy(flyGoal.pos);
          controls.target.copy(flyGoal.target);
          flyGoal = null;
        }
        return;
      }
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
      previewRing.geometry.dispose();
      (previewRing.material as THREE.Material).dispose();
      controls.dispose();
      terrain.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // 中心・半径・パネル開閉に応じてプレビュー円を更新する。
  useEffect(() => {
    apiRef.current?.setPreview(panelOpen ? center : null, radiusKm);
  }, [center, radiusKm, panelOpen]);

  // ベースマップ切替を地形へ反映する。
  useEffect(() => {
    apiRef.current?.setBasemap(basemapById(basemapId));
  }, [basemapId]);

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
  const captureCenter = () => {
    setCenter(apiRef.current?.getCenter() ?? null);
  };
  const startDownload = async () => {
    if (!plan || plan.jobs.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(true);
    setProgress({ done: 0, total: plan.jobs.length, failed: 0 });
    await runPrefetch(plan, basemapById(basemapId), setProgress, controller.signal);
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

  // --- 検索 → フライト --- //
  const runQuery = async (q: string, mode: SearchMode) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const r = await runSearch(q, mode);
    setSearching(false);
    setResults(r);
  };
  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void runQuery(query, searchMode);
  };
  const changeMode = (mode: SearchMode) => {
    setSearchMode(mode);
    if (query.trim()) void runQuery(query, mode); // 入力済みなら即座に引き直す
  };
  const goToResult = (r: SearchResult) => {
    apiRef.current?.flyTo({ lat: r.lat, lon: r.lon });
    setResults([]);
    setQuery(r.title);
  };

  const SEARCH_MODES: { id: SearchMode; label: string }[] = [
    { id: "mountain", label: "山名" },
    { id: "place", label: "土地名" },
    { id: "both", label: "両方" },
  ];

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

      {/* 山名・土地名検索 → フライト（上中央） */}
      <div className="search">
        <div className="search-modes">
          {SEARCH_MODES.map((m) => (
            <button
              key={m.id}
              className={m.id === searchMode ? "is-active" : ""}
              onClick={() => changeMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <form className="search-bar" onSubmit={doSearch}>
          <input
            type="search"
            value={query}
            placeholder={
              searchMode === "mountain"
                ? "山名で検索（例: 槍ヶ岳）"
                : searchMode === "place"
                  ? "地名で検索（例: 上高地）"
                  : "山名・地名で検索（例: 富士山）"
            }
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" title="検索" disabled={searching}>
            {searching ? "…" : "🔍"}
          </button>
        </form>
        {results.length > 0 && (
          <ul className="search-results">
            {results.map((r, i) => (
              <li key={`${r.kind},${r.lat},${r.lon},${i}`}>
                <button onClick={() => goToResult(r)}>
                  <span className="res-ico">{r.kind === "mountain" ? "⛰" : "📍"}</span>
                  <span className="res-title">{r.title}</span>
                  {r.kind === "mountain" && (
                    <span className="res-sub">
                      {r.elevationM}m{r.sub ? ` ・ ${r.sub}` : ""}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button className="save-open" title="オフライン保存（事前ロード）" onClick={openPanel}>
        ⤓ 保存
      </button>

      {/* ベースマップ切替（左下） */}
      <div className="basemap-switch">
        {BASEMAPS.map((b) => (
          <button
            key={b.id}
            className={b.id === basemapId ? "is-active" : ""}
            onClick={() => setBasemapId(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>

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

      {/* オフライン保存パネル（中心＋半径） */}
      {panelOpen && (
        <div className="save-panel">
          <div className="save-head">
            <span>オフライン保存</span>
            <button className="save-close" title="閉じる" onClick={() => setPanelOpen(false)}>×</button>
          </div>

          <p className="save-note">
            画面中央（見ている地点）を中心に、指定した半径・詳細度ぶんを保存します。
            保存後は通信なしでもその範囲を3D表示できます。
          </p>

          <button className="save-btn" onClick={captureCenter} disabled={downloading}>
            画面中央を中心地点にする
          </button>

          {center && (
            <div className="save-center">
              中心: {center.lat.toFixed(4)}°, {center.lon.toFixed(4)}°
            </div>
          )}

          <label className="save-field">
            <span>半径: {radiusKm} km</span>
            <input
              type="range"
              min={RADIUS_MIN}
              max={RADIUS_MAX}
              value={radiusKm}
              disabled={downloading}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
            />
          </label>

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

          {plan && (
            <div className="save-plan">
              {plan.jobs.length === 0 ? (
                <span className="save-warn">この中心は日本の範囲外です。</span>
              ) : (
                <>
                  <div>
                    タイル数: <b>{plan.jobs.length.toLocaleString()}</b>（航空写真 {plan.aerialCount.toLocaleString()} ＋ 標高 {plan.demCount.toLocaleString()}）
                  </div>
                  <div>サイズ目安: 約 {formatBytes(plan.estBytes)}</div>
                  {plan.truncated && (
                    <div className="save-warn">範囲が広すぎるため上限で打ち切りました。半径を小さくしてください。</div>
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
