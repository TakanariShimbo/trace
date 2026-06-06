import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { QuadtreeTerrain } from "../terrain/QuadtreeTerrain";
import { CelestialLayer } from "../terrain/CelestialLayer";
import { SkyDome } from "../terrain/SkyDome";
import { computeSky, computeTrack, type SkyState, type SkyBody } from "../lib/celestial";
import {
  IconMountain,
  IconPin,
  IconDownload,
  IconCaret,
  IconRotate,
  IconHome,
  IconPlus,
  IconMinus,
  IconLocate,
  IconCamera,
  IconMap,
} from "./icons";
import {
  worldToLonLat,
  lonToMercX,
  latToMercY,
  mercXToWorld,
  mercYToWorld,
  elevToWorldY,
  setVerticalExaggeration as applyVEX,
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

// カメラ視点の既定値。
const CAM_FOV_DEFAULT = 55;
const CAM_FOV_MIN = 20;
const CAM_FOV_MAX = 90;
const CAM_PITCH_LIMIT = 80;
const CAM_EYE_DEFAULT = 1.6; // 目線高さ(m, 地表から)
const VEX_MAP_DEFAULT = 1.7; // 地図モードの標高誇張
const VEX_CAM_DEFAULT = 1.0; // カメラ視点モードの標高誇張（実寸）
const CAM_CELESTIAL_R = 5000; // カメラ視点で太陽月を置く半径(ワールド≒遠方の空)

// Date → <input type="date"> 用のローカル日付文字列 (YYYY-MM-DD)。
function toDateInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 方位az(0=北,90=東)・仰角alt(0=水平) → 単位方向(X=東,Y=上,Z=南で北=-Z)。
function dirAzAlt(azDeg: number, altDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (azDeg * Math.PI) / 180;
  const e = (altDeg * Math.PI) / 180;
  return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
}

export default function MapView() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // 画面ボタンとレンダリングループで共有する操作状態（.current は callback/effect 内でのみ触る）。
  const navRef = useRef<Nav>({ panX: 0, panZ: 0, orbit: 0, tilt: 0, dolly: 0, home: false });
  // effect 内で作る各種カメラ/地形操作を React 側へ橋渡しする。
  const apiRef = useRef<{
    getCenter: () => LonLat | null;
    setPreview: (center: LonLat | null, radiusKm: number) => void;
    flyTo: (c: LonLat) => void;
    setBasemap: (layer: Basemap) => void;
    setCelestialActive: (on: boolean) => void;
    setCelestialSky: (sky: SkyState | null, sunTrack: SkyBody[], moonTrack: SkyBody[]) => void;
    setFreeLook: (on: boolean) => void;
    enterCamera: (eyeHeightM: number) => { heading: number; pitch: number; fov: number };
    exitCamera: () => void;
    setCamLook: (heading: number, pitch: number) => void;
    setCamFov: (fov: number) => void;
    setCamEyeHeight: (m: number) => void;
    setVerticalExaggeration: (v: number) => void;
    setSkySunDir: (x: number, y: number, z: number) => void;
  } | null>(null);
  // 直近に判明した現在地（起動時＋現在地ボタンで更新）。ホームの基準に使う。
  const homeLocRef = useRef<LonLat | null>(null);
  // 中心レティクル（ループから画面座標を更新する）。
  const reticleRef = useRef<SVGSVGElement | null>(null);

  // --- ベースマップ・検索の状態 --- //
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id);
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("both");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false); // 現在地取得中
  const [locError, setLocError] = useState<string | null>(null);
  // サイドバー開閉と、右下リモコンの表示。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showRemote, setShowRemote] = useState(false);
  // 中心マーカー（視点中心＝画面中央の目印）。画面中央のレティクルで表示する。
  const [showCenter, setShowCenter] = useState(true);
  // 空グラデーション表示。
  const [showSky, setShowSky] = useState(true);
  const showSkyRef = useRef(true);
  // 視点フリーモード（解像度・太陽月・円盤を凍結して視点だけ動かす）。
  const [freeLook, setFreeLook] = useState(false);
  // 標高の誇張（×1=実寸 1:1:1）。モードごとに既定が異なる（地図1.7 / カメラ1.0）。
  const [mapVex, setMapVex] = useState(VEX_MAP_DEFAULT);
  const [camVex, setCamVex] = useState(VEX_CAM_DEFAULT);

  // --- カメラ視点モード（3Dマップを一人称カメラとして使う） --- //
  const [mode, setMode] = useState<"map" | "camera">("map");
  const [camHeading, setCamHeading] = useState(0);
  const [camPitch, setCamPitch] = useState(0);
  const [camFov, setCamFov] = useState(CAM_FOV_DEFAULT);
  const [camEyeHeight, setCamEyeHeight] = useState(CAM_EYE_DEFAULT);
  // サイドバー各セクションの開閉（よく使う検索・地図は既定で開く）。
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({
    search: true,
    map: true,
    view: false,
    sun: false,
    save: false,
  });
  const toggleSec = (id: string) => setOpenSec((s) => ({ ...s, [id]: !s[id] }));
  const secClass = (id: string) => `side-sec${openSec[id] ? "" : " is-collapsed"}`;

  // --- 太陽・月 --- //
  const [celestialOn, setCelestialOn] = useState(false);
  const [sunObserver, setSunObserver] = useState<LonLat | null>(null);
  // 現在時刻を中心(0)に、±12時間のオフセットで観測日時を作る。
  // 日付（自由指定）＋時刻スライダー。既定は現在日時。
  const [dateStr, setDateStr] = useState(() => toDateInput(new Date()));
  const [minutes, setMinutes] = useState(() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  });
  const skyDate = useMemo(() => {
    const [y, mo, da] = dateStr.split("-").map(Number);
    return new Date(y, (mo || 1) - 1, da || 1, Math.floor(minutes / 60), minutes % 60);
  }, [dateStr, minutes]);
  // 観測点＋日時から太陽月の状態（UI表示＆レイヤ反映に使う）。
  const skyInfo = useMemo<SkyState | null>(
    () => (celestialOn && sunObserver ? computeSky(skyDate, sunObserver.lat, sunObserver.lon) : null),
    [celestialOn, sunObserver, skyDate],
  );

  // --- 事前ロード（オフライン保存）UI の状態 --- //
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

    // 太陽・月の天球オーバーレイ。中心＝視点中心(controls.target)に毎フレーム追従し、
    // 半径はカメラ距離に連動。パン・ズームの両方に円盤と太陽月が連動する。
    const celestial = new CelestialLayer();
    scene.add(celestial.group);
    let celestialActive = false;
    const celestialCenter = new THREE.Vector3();
    let lastObsWorld: THREE.Vector2 | null = null; // 直近に sky を計算した中心(world XZ)

    // 太陽位置に連動する空グラデーション（カメラ視点の背景）。
    const skyDome = new SkyDome();
    scene.add(skyDome.mesh);
    const sunDirWorld = new THREE.Vector3(0, 1, 0); // 直近の太陽方向（setCelestialSky で更新）

    // 視点フリーモード: ON の間は地形LOD・円盤・太陽月を凍結し、カメラだけ動かせる。
    // OFF にしたら、ON にした瞬間の視点へ戻す。
    let freeLookActive = false;
    let savedPose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const projTmp = new THREE.Vector3(); // 中心点の画面投影用

    // --- カメラ視点モード --- //
    let cameraMode = false;
    let mapPose: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const cam = { heading: 0, pitch: 0, fov: CAM_FOV_DEFAULT, eyeX: 0, eyeZ: 0, groundElevM: 0, eyeHeightM: CAM_EYE_DEFAULT };
    const dirTmp = new THREE.Vector3();
    const camRay = new THREE.Raycaster();
    const DOWN = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();
    const reticleWorld = new THREE.Vector3();
    const sampleSurfaceY = (x: number, z: number): number => {
      // 観測点の上空から真下へレイし、表示中の地形メッシュ表面の高さを得る。
      rayOrigin.set(x, 9000, z);
      camRay.set(rayOrigin, DOWN);
      const hits = camRay.intersectObjects(terrain.group.children, false);
      return hits.length ? hits[0].point.y : 0;
    };

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
      setCelestialActive: (on) => {
        celestialActive = on;
        celestial.setVisible(on);
        if (!on) {
          terrain.setClip(null, 0); // 解除時は全面表示へ
          lastObsWorld = null;
        }
      },
      setCelestialSky: (sky, sunTrack, moonTrack) => {
        celestial.setSky(sky, sunTrack, moonTrack);
        if (sky) dirAzAlt(sky.sun.azimuthDeg, sky.sun.altitudeDeg, sunDirWorld);
      },
      setFreeLook: (on) => {
        if (on) {
          savedPose = { pos: camera.position.clone(), target: controls.target.clone() };
          freeLookActive = true;
        } else {
          freeLookActive = false;
          if (savedPose) {
            flyGoal = savedPose; // モード前の視点へ滑らかに戻す
            savedPose = null;
          }
        }
      },
      enterCamera: (eyeHeightM) => {
        mapPose = { pos: camera.position.clone(), target: controls.target.clone() };
        cam.eyeX = controls.target.x;
        cam.eyeZ = controls.target.z;
        // 地表のワールドYを実標高(m)に戻して保持（VEX変更にも追従できる）。
        cam.groundElevM = sampleSurfaceY(cam.eyeX, cam.eyeZ) / Math.max(1e-9, elevToWorldY(1));
        cam.eyeHeightM = eyeHeightM;
        camera.getWorldDirection(dirTmp); // 初期方位＝今の水平向き
        cam.heading = ((Math.atan2(dirTmp.x, -dirTmp.z) * 180) / Math.PI + 360) % 360;
        cam.pitch = 0;
        cam.fov = CAM_FOV_DEFAULT;
        terrain.setClip(null, 0); // 円盤クリップ解除（カメラ視点は切り抜かない）
        cameraMode = true;
        controls.enabled = false;
        return { heading: cam.heading, pitch: cam.pitch, fov: cam.fov };
      },
      exitCamera: () => {
        cameraMode = false;
        controls.enabled = true;
        if (mapPose) {
          camera.position.copy(mapPose.pos);
          controls.target.copy(mapPose.target);
          mapPose = null;
        }
        camera.fov = CAM_FOV_DEFAULT;
        camera.updateProjectionMatrix();
        controls.update();
      },
      setCamLook: (heading, pitch) => {
        cam.heading = heading;
        cam.pitch = pitch;
      },
      setCamFov: (fov) => {
        cam.fov = fov;
      },
      setCamEyeHeight: (m) => {
        cam.eyeHeightM = m;
      },
      setVerticalExaggeration: (v) => {
        applyVEX(v);
        terrain.rebuild(); // 標高はメッシュ頂点に焼き込み済みなので作り直し
      },
      setSkySunDir: (x, y, z) => sunDirWorld.set(x, y, z),
    };

    // --- カメラ視点の見回し操作（1本指=向き / 2本指ピンチ=画角 / ホイール=画角） --- //
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    const pinchDistance = (): number => {
      const pts = [...pointers.values()];
      return pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    };
    const onCamDown = (e: PointerEvent) => {
      if (!cameraMode) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) pinchDist = pinchDistance();
    };
    const onCamMove = (e: PointerEvent) => {
      if (!cameraMode) return;
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size >= 2) {
        // 2本指ピンチ＝画角。指を開く(距離↑)=ズームイン=fov減。
        const d = pinchDistance();
        if (pinchDist > 0 && d > 0) {
          cam.fov = THREE.MathUtils.clamp(cam.fov * (pinchDist / d), CAM_FOV_MIN, CAM_FOV_MAX);
          setCamFov(cam.fov);
        }
        pinchDist = d;
      } else {
        // 1本指＝向き（ズーム(小fov)ほど感度を下げる）。
        const degPerPx = cam.fov / mount.clientHeight;
        cam.heading = (cam.heading - dx * degPerPx + 360) % 360;
        cam.pitch = THREE.MathUtils.clamp(cam.pitch + dy * degPerPx, -CAM_PITCH_LIMIT, CAM_PITCH_LIMIT);
        setCamHeading(cam.heading);
        setCamPitch(cam.pitch);
      }
    };
    const onCamUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pinchDist = 0; // 残り1本になったら次の move で再計算
    };
    const onCamWheel = (e: WheelEvent) => {
      if (!cameraMode) return;
      e.preventDefault();
      cam.fov = THREE.MathUtils.clamp(cam.fov + Math.sign(e.deltaY) * 3, CAM_FOV_MIN, CAM_FOV_MAX);
      setCamFov(cam.fov);
    };
    renderer.domElement.addEventListener("pointerdown", onCamDown);
    window.addEventListener("pointermove", onCamMove);
    window.addEventListener("pointerup", onCamUp);
    window.addEventListener("pointercancel", onCamUp);
    renderer.domElement.addEventListener("wheel", onCamWheel, { passive: false });

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
    const loop = () => {
      if (cameraMode) {
        // カメラ視点：視点位置に固定し、heading/pitch/fov で向きと画角を作る。
        const eyeY = elevToWorldY(cam.groundElevM + cam.eyeHeightM);
        camera.position.set(cam.eyeX, eyeY, cam.eyeZ);
        dirAzAlt(cam.heading, cam.pitch, dirTmp);
        camera.lookAt(cam.eyeX + dirTmp.x, eyeY + dirTmp.y, cam.eyeZ + dirTmp.z);
        if (camera.fov !== cam.fov) {
          camera.fov = cam.fov;
          camera.updateProjectionMatrix();
        }
        if (reticleRef.current) reticleRef.current.style.display = "none";
        // 太陽・月：カメラ視点では切り抜かず、視点(目)を中心に遠方の空へ配置。
        if (celestialActive) {
          celestial.setHorizonVisible(false);
          celestialCenter.set(cam.eyeX, eyeY, cam.eyeZ);
          celestial.place(celestialCenter, CAM_CELESTIAL_R);
        }
        // 空グラデーション（太陽位置に連動）。表示トグルで切替。
        // 太陽方向は 太陽月ON=選択時刻 / OFF=現在時刻（下の effect が sunDirWorld を更新）。
        skyDome.setVisible(showSkyRef.current);
        skyDome.setSunDir(sunDirWorld);
        skyDome.place(camera.position);
        terrain.update(camera, mount.clientHeight, 30);
        renderer.render(scene, camera);
        raf = requestAnimationFrame(loop);
        return;
      }

      applyNav();
      controls.update();
      const camDist = camera.position.distanceTo(controls.target);
      // 空グラデーション（地図モードでも傾ければ見える。表示トグルで切替）。
      skyDome.setVisible(showSkyRef.current);
      skyDome.setSunDir(sunDirWorld);
      skyDome.place(camera.position);
      // 視点フリー中は、地形LOD・円盤・太陽月の連動を凍結（カメラだけ動かす）。
      if (!freeLookActive) {
        // 円盤クリップは terrain.update より前に設定（refine が当該フレームの半径を使う）。
        if (celestialActive) {
          // 中心＝視点中心。半径＝カメラ距離連動。パン・ズームに円盤と太陽月が追従。
          celestial.setHorizonVisible(true);
          const tx = controls.target.x;
          const tz = controls.target.z;
          celestialCenter.set(tx, controls.target.y, tz);
          const diskR = THREE.MathUtils.clamp(camera.position.distanceTo(celestialCenter) * 0.5, 2, 4000);
          terrain.setClip({ x: tx, z: tz }, diskR);
          celestial.place(celestialCenter, diskR * 1.1);
          // 中心が十分動いたら sky(太陽月の方位高度・軌跡)を計算し直す。
          const thr = Math.max(1, diskR * 0.08);
          if (!lastObsWorld || Math.hypot(tx - lastObsWorld.x, tz - lastObsWorld.y) > thr) {
            lastObsWorld = (lastObsWorld ?? new THREE.Vector2()).set(tx, tz);
            setSunObserver(worldToLonLat(tx, tz));
          }
        }
        terrain.update(camera, mount.clientHeight, camDist);
      }

      // 中心レティクルは「マップの中心」を、その地点の地形表面の高さに置いて画面投影。
      // （Y=0の海面ではなく地表に合わせる＝斜め視点でも山頂などにピタリ合う）
      const reticle = reticleRef.current;
      if (reticle) {
        const mc = freeLookActive && savedPose ? savedPose.target : controls.target;
        reticleWorld.set(mc.x, sampleSurfaceY(mc.x, mc.z), mc.z);
        projTmp.copy(reticleWorld).project(camera);
        if (projTmp.z <= 1) {
          reticle.style.display = "block";
          reticle.style.left = `${(projTmp.x * 0.5 + 0.5) * mount.clientWidth}px`;
          reticle.style.top = `${(-projTmp.y * 0.5 + 0.5) * mount.clientHeight}px`;
        } else {
          reticle.style.display = "none"; // カメラ後方なら隠す
        }
      }

      renderer.render(scene, camera);
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
      renderer.domElement.removeEventListener("pointerdown", onCamDown);
      window.removeEventListener("pointermove", onCamMove);
      window.removeEventListener("pointerup", onCamUp);
      window.removeEventListener("pointercancel", onCamUp);
      renderer.domElement.removeEventListener("wheel", onCamWheel);
      ro.disconnect();
      apiRef.current = null;
      previewRing.geometry.dispose();
      (previewRing.material as THREE.Material).dispose();
      celestial.dispose();
      skyDome.dispose();
      controls.dispose();
      terrain.dispose();
      renderer.dispose();
      // HMR等で作り直す際、古いWebGLコンテキストを明示解放（コンテキスト枯渇＝真っ黒の予防）。
      renderer.forceContextLoss();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // 中心・半径・サイドバー開閉に応じてプレビュー円を更新する。
  useEffect(() => {
    apiRef.current?.setPreview(sidebarOpen ? center : null, radiusKm);
  }, [center, radiusKm, sidebarOpen]);

  // サイドバーを開いたら保存済み容量を取得し直す。
  useEffect(() => {
    if (sidebarOpen) navigator.storage?.estimate?.().then((e) => setStorageUsage(e.usage ?? 0));
  }, [sidebarOpen]);

  // ベースマップ切替を地形へ反映する。
  useEffect(() => {
    apiRef.current?.setBasemap(basemapById(basemapId));
  }, [basemapId]);

  // 空グラデーション表示の切替（ループから参照する ref に同期）。
  useEffect(() => {
    showSkyRef.current = showSky;
  }, [showSky]);

  // 初回起動: 現在地が取れればそこへ移動し、ホームの基準にする。取れなければ日本全体ビューのまま。
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        homeLocRef.current = loc;
        apiRef.current?.flyTo(loc);
      },
      () => undefined, // 失敗・拒否時は既定ビューのまま
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }, []);

  // 太陽・月: 観測点(=視点中心)＋日時から sky/軌跡を計算して反映。中心追従はループ側。
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (!celestialOn || !sunObserver || !skyInfo) {
      api.setCelestialActive(false);
      return;
    }
    const sunTrack = computeTrack(skyDate, sunObserver.lat, sunObserver.lon, "sun");
    const moonTrack = computeTrack(skyDate, sunObserver.lat, sunObserver.lon, "moon");
    api.setCelestialSky(skyInfo, sunTrack, moonTrack);
    api.setCelestialActive(true);
  }, [celestialOn, sunObserver, skyDate, skyInfo]);

  // 太陽月OFFのときは、空の太陽方向を「現在時刻」で計算してセット（地図・カメラ共通）。
  // （太陽月ON のときは setCelestialSky が選択時刻で更新するのでここは何もしない）
  useEffect(() => {
    const api = apiRef.current;
    if (!api || celestialOn) return;
    const center = api.getCenter();
    if (!center) return;
    const sky = computeSky(new Date(), center.lat, center.lon);
    const d = dirAzAlt(sky.sun.azimuthDeg, sky.sun.altitudeDeg, new THREE.Vector3());
    api.setSkySunDir(d.x, d.y, d.z);
  }, [mode, celestialOn]);

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
    setSidebarOpen(false); // 飛んだ先の地図が見えるよう閉じる
  };

  // --- 現在地へ移動（GPS） --- //
  const goToCurrentLocation = () => {
    if (!navigator.geolocation) {
      setLocError("この端末では現在地を取得できません");
      return;
    }
    setLocError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        homeLocRef.current = loc;
        apiRef.current?.flyTo(loc);
        setSidebarOpen(false);
      },
      (err) => {
        setLocating(false);
        setLocError(
          err.code === err.PERMISSION_DENIED
            ? "位置情報の利用が許可されていません"
            : err.code === err.TIMEOUT
              ? "現在地の取得がタイムアウトしました"
              : "現在地を取得できませんでした",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  // 視点フリーの切替（ONで凍結、OFFでモード前の視点へ戻す）。
  const toggleFreeLook = () => {
    const nv = !freeLook;
    setFreeLook(nv);
    apiRef.current?.setFreeLook(nv);
  };

  // カメラ視点モードへ（太陽月は維持。自由視点はマップ専用なのでオフにしてから入る）。
  const enterCameraMode = () => {
    if (freeLook) {
      setFreeLook(false);
      apiRef.current?.setFreeLook(false);
    }
    const init = apiRef.current?.enterCamera(camEyeHeight); // 地表高さは現在(地図VEX)で取得
    if (init) {
      setCamHeading(init.heading);
      setCamPitch(init.pitch);
      setCamFov(init.fov);
    }
    apiRef.current?.setVerticalExaggeration(camVex); // カメラ用VEXへ（地形再生成）
    setMode("camera");
  };
  const exitCameraMode = () => {
    apiRef.current?.exitCamera();
    apiRef.current?.setVerticalExaggeration(mapVex); // 地図用VEXへ戻す（地形再生成）
    setMode("map");
  };
  // 現在モードの標高誇張を変更（モードごとに記憶）。
  const activeVex = mode === "camera" ? camVex : mapVex;
  const changeVex = (v: number) => {
    if (mode === "camera") setCamVex(v);
    else setMapVex(v);
    apiRef.current?.setVerticalExaggeration(v);
  };
  const changeCamEyeHeight = (m: number) => {
    setCamEyeHeight(m);
    apiRef.current?.setCamEyeHeight(m);
  };
  const compass = (deg: number) => {
    const dirs = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
    return dirs[Math.round(((deg % 360) / 45)) % 8];
  };

  // ホーム: 現在地が判明していればそこへ、なければ日本全体ビューへ。
  const goHome = () => {
    if (homeLocRef.current) apiRef.current?.flyTo(homeLocRef.current);
    else navRef.current.home = true;
  };

  // --- 太陽・月操作 --- //
  const toggleCelestial = (on: boolean) => {
    setCelestialOn(on);
    if (on && !sunObserver) setSunObserver(apiRef.current?.getCenter() ?? null);
  };
  const setSunNow = () => {
    const d = new Date();
    setDateStr(toDateInput(d));
    setMinutes(d.getHours() * 60 + d.getMinutes());
  };
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmtTime = (d: Date | null) => (d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "—");
  const hhmm = `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

  const secHead = (id: string, title: string) => (
    <button className="side-sec-head" onClick={() => toggleSec(id)} aria-expanded={openSec[id]}>
      <span>{title}</span>
      <span className={`side-chev${openSec[id] ? " is-open" : ""}`} />
    </button>
  );

  const SEARCH_MODES: { id: SearchMode; label: string }[] = [
    { id: "mountain", label: "山名" },
    { id: "place", label: "土地名" },
    { id: "both", label: "両方" },
  ];

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="mapview">
      <div className="mapview-canvas" ref={mountRef} />

      {/* 中心レティクル（注視点＝画面中央の目印） */}
      {mode === "map" && showCenter && (
        <svg ref={reticleRef} className="center-reticle" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
          <circle cx="16" cy="16" r="8.5" fill="none" stroke="#8fe0ff" strokeWidth="1.6" />
          <circle cx="16" cy="16" r="1.5" fill="#8fe0ff" />
          <line x1="16" y1="2.5" x2="16" y2="6.5" stroke="#8fe0ff" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="16" y1="25.5" x2="16" y2="29.5" stroke="#8fe0ff" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="2.5" y1="16" x2="6.5" y2="16" stroke="#8fe0ff" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="25.5" y1="16" x2="29.5" y2="16" stroke="#8fe0ff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}

      {/* メニュー開閉（左上） */}
      <button
        className="menu-toggle"
        title="メニュー"
        aria-label="メニュー"
        onClick={() => setSidebarOpen((o) => !o)}
      >
        ☰
      </button>

      {/* 地図⇄カメラ視点の切替（右上） */}
      <button
        className={`mode-toggle${mode === "camera" ? " is-camera" : ""}`}
        title={mode === "map" ? "カメラ視点：今見ている地点に立って見回す" : "地図に戻る"}
        onClick={mode === "map" ? enterCameraMode : exitCameraMode}
      >
        {mode === "map" ? <IconCamera size={16} /> : <IconMap size={16} />}
        <span>{mode === "map" ? "カメラ視点" : "地図に戻る"}</span>
      </button>

      {/* カメラ視点モードのHUD（下） */}
      {mode === "camera" && (
        <div className="cam-hud">
          <div className="cam-readout">
            <span>方位 {compass(camHeading)} {Math.round(camHeading)}°</span>
            <span>仰角 {Math.round(camPitch)}°</span>
            <span>画角 {Math.round(camFov)}°</span>
          </div>
          <label className="cam-eye">
            <span>目線高さ {camEyeHeight} m</span>
            <input
              type="range"
              min={1}
              max={200}
              value={camEyeHeight}
              onChange={(e) => changeCamEyeHeight(Number(e.target.value))}
            />
          </label>
          <div className="cam-hint">ドラッグで見回す ／ ホイール・ピンチで画角</div>
        </div>
      )}

      {/* サイドバー背景（タップで閉じる） */}
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      {/* サイドバー：検索・地図・表示・事前保存 */}
      <aside className={`sidebar${sidebarOpen ? " is-open" : ""}`}>
        <div className="sidebar-head">
          <span>GSI 3D Map</span>
          <button className="sidebar-close" title="閉じる" onClick={() => setSidebarOpen(false)}>×</button>
        </div>

        {/* 検索 */}
        <section className={secClass("search")}>
          {secHead("search", "検索")}
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
            <button type="submit" title="検索" aria-label="検索" disabled={searching}>
              {searching ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="10.5" cy="10.5" r="6.5" />
                  <line x1="15.5" y1="15.5" x2="21" y2="21" />
                </svg>
              )}
            </button>
          </form>

          <button className="save-btn" onClick={goToCurrentLocation} disabled={locating}>
            {locating ? <span className="spinner" aria-hidden="true" /> : <IconLocate size={16} />}
            {locating ? "取得中…" : "現在地へ移動"}
          </button>
          {locError && <div className="save-warn">{locError}</div>}
          {results.length > 0 && (
            <ul className="search-results">
              {results.map((r, i) => (
                <li key={`${r.kind},${r.lat},${r.lon},${i}`}>
                  <button onClick={() => goToResult(r)}>
                    <span className="res-ico">
                      {r.kind === "mountain" ? <IconMountain size={15} /> : <IconPin size={15} />}
                    </span>
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
        </section>

        {/* 地図（ベースマップ） */}
        <section className={secClass("map")}>
          {secHead("map", "地図")}
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
        </section>

        {/* 表示 */}
        <section className={secClass("view")}>
          {secHead("view", "表示")}
          <label className="side-toggle">
            <input
              type="checkbox"
              checked={showRemote}
              onChange={(e) => setShowRemote(e.target.checked)}
            />
            <span>操作リモコンを表示（右下）</span>
          </label>
          <label className="side-toggle">
            <input
              type="checkbox"
              checked={showCenter}
              onChange={(e) => setShowCenter(e.target.checked)}
            />
            <span>中心マーカーを表示</span>
          </label>
          <label className="side-toggle">
            <input
              type="checkbox"
              checked={showSky}
              onChange={(e) => setShowSky(e.target.checked)}
            />
            <span>空のグラデーションを表示</span>
          </label>
          <label className="save-field">
            <span>
              標高の誇張（{mode === "camera" ? "カメラ" : "地図"}）: ×{activeVex.toFixed(1)}
              {activeVex === 1 ? "（実寸 1:1:1）" : ""}
            </span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={activeVex}
              onChange={(e) => changeVex(Number(e.target.value))}
            />
          </label>
        </section>

        {/* 太陽・月 */}
        <section className={secClass("sun")}>
          {secHead("sun", "太陽・月")}
          <label className="side-toggle">
            <input
              type="checkbox"
              checked={celestialOn}
              onChange={(e) => toggleCelestial(e.target.checked)}
            />
            <span>太陽・月を表示</span>
          </label>

          {celestialOn && (
            <>
              {sunObserver && (
                <div className="save-center">
                  中心: {sunObserver.lat.toFixed(4)}°, {sunObserver.lon.toFixed(4)}°
                </div>
              )}

              <label className="save-field">
                <span>日付</span>
                <input
                  type="date"
                  value={dateStr}
                  onChange={(e) => setDateStr(e.target.value)}
                />
              </label>

              <label className="save-field">
                <span>時刻: {hhmm}</span>
                <input
                  type="range"
                  min={0}
                  max={1439}
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                />
              </label>

              <button className="save-link" onClick={setSunNow}>
                現在日時にリセット
              </button>

              {skyInfo && (
                <div className="save-plan">
                  <div>
                    ☀ 太陽: 方位 {skyInfo.sun.azimuthDeg.toFixed(0)}° / 高度{" "}
                    {skyInfo.sun.altitudeDeg.toFixed(0)}°
                    {!skyInfo.sun.visible && "（地平線下）"}
                  </div>
                  <div>
                    ☾ 月: 方位 {skyInfo.moon.azimuthDeg.toFixed(0)}° / 高度{" "}
                    {skyInfo.moon.altitudeDeg.toFixed(0)}°
                    {!skyInfo.moon.visible && "（地平線下）"}
                  </div>
                  <div>
                    月齢: 照度 {(skyInfo.moonFraction * 100).toFixed(0)}%（
                    {skyInfo.moonWaxing ? "満ちる" : "欠ける"}）
                  </div>
                  <div>
                    日の出 {fmtTime(skyInfo.sunrise)} / 日の入 {fmtTime(skyInfo.sunset)}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        {/* 事前保存（オフライン） */}
        <section className={secClass("save")}>
          {secHead("save", "事前保存（オフライン）")}
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
                <IconDownload size={16} />
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
        </section>
      </aside>

      {/* 右下クラスタ（マップモードのみ）: リモコン＋その下に自由視点 */}
      {mode === "map" && (
        <div className="controls-br">
          {showRemote && (
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
            <button className="nav-btn" title="左に回す" {...hold({ orbit: 1 }, "orbit")}>
              <IconRotate dir="ccw" />
            </button>
            <button className="nav-btn" title="右に回す" {...hold({ orbit: -1 }, "orbit")}>
              <IconRotate dir="cw" />
            </button>
          </div>
          <div className="nav-pad">
            <button className="nav-btn nav-up" title="前へ" {...hold({ panZ: 1 }, "panZ")}>
              <IconCaret dir="up" />
            </button>
            <button className="nav-btn nav-left" title="左へ" {...hold({ panX: -1 }, "panX")}>
              <IconCaret dir="left" />
            </button>
            <button className="nav-btn nav-home" title="ホーム（現在地）" onClick={goHome}>
              <IconHome />
            </button>
            <button className="nav-btn nav-right" title="右へ" {...hold({ panX: 1 }, "panX")}>
              <IconCaret dir="right" />
            </button>
            <button className="nav-btn nav-down" title="後ろへ" {...hold({ panZ: -1 }, "panZ")}>
              <IconCaret dir="down" />
            </button>
          </div>
          <div className="nav-zoom">
            <button className="nav-btn" title="ズームイン" {...hold({ dolly: 1 }, "dolly")}>
              <IconPlus />
            </button>
            <button className="nav-btn" title="ズームアウト" {...hold({ dolly: -1 }, "dolly")}>
              <IconMinus />
            </button>
          </div>
            </div>
          )}
          {/* 自由視点（リモコンの下） */}
          <button
            className={`freelook-toggle${freeLook ? " is-active" : ""}`}
            title="自由視点：地図解像度・太陽・月を固定したまま視点だけ動かす。解除すると元の視点へ戻ります"
            onClick={toggleFreeLook}
          >
            {freeLook ? "自由視点：ON" : "自由視点"}
          </button>
        </div>
      )}

      <div className="attribution">
        出典:{" "}
        <a
          href="https://maps.gsi.go.jp/development/ichiran.html"
          target="_blank"
          rel="noreferrer"
        >
          地理院タイル
        </a>
        （国土地理院）を加工して表示
      </div>
    </div>
  );
}
