import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { QuadtreeTerrain } from "../terrain/QuadtreeTerrain";
import { CelestialLayer } from "../terrain/CelestialLayer";
import { SkyDome } from "../terrain/SkyDome";
import { PeakMarkers } from "../terrain/PeakMarkers";
import { loadAllMountains } from "../lib/mountains";
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
  IconSun,
  IconMoonPhase,
  IconImage,
  IconChevron,
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
import { readPhotoExif } from "../lib/exif";
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

// 地図モードの縦画角（Three.js の PerspectiveCamera.fov は縦画角）。
const MAP_FOV = 55;
// カメラ視点の既定値。CAM_FOV_* は「横画角」(deg)。毎フレーム現在のアスペクト比から
// 縦画角に換算して camera.fov へ入れる（ディスプレイ比が変わっても横の写りが一定）。
const CAM_FOV_DEFAULT = 75; // 横画角の既定（一般的なスマホカメラ相当）
// 横画角の下限は小さめに。縦持ち(縦長アスペクト)だと横固定により縦画角が広がるが、
// 横を絞れば縦も比例して下がるので、下限を低くしておけばユーザー側で回避できる
// （遠くの山を覗き込む望遠ズームとしても有用）。
const CAM_FOV_MIN = 15;
const CAM_FOV_MAX = 110;
const CAM_PITCH_LIMIT = 80;
const CAM_EYE_DEFAULT = 1.6; // 目線高さ(m, 地表から)
const VEX_MAP_DEFAULT = 1.7; // 地図モードの標高誇張
const VEX_CAM_DEFAULT = 1.0; // カメラ視点モードの標高誇張（実寸）
const PEAKS_DEFAULT_ON = true; // 山頂マーカー・山名ラベルを既定で表示するか
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

type MapViewProps = {
  appMode: "simulation" | "ar"; // シミュレーション / AR（写真から）。ホーム画面から指定される。
  onHome: () => void; // ホーム画面へ戻る。
};

// ARウィザードのフェーズ。
type ArStep = "upload" | "locate" | "params" | "align" | "select" | "export";

// 出力(仕上げ)で編集する山ラベル。dot=点、label=名札。座標は写真フレーム内の正規化値(0..1)。
type ArLabel = {
  name: string;
  elevM: number;
  dotU: number;
  dotV: number;
  labelU: number;
  labelV: number;
};

export default function MapView({ appMode, onHome }: MapViewProps) {
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
    enterCamera: (
      eyeHeightM: number,
      override?: { lon: number; lat: number; headingDeg?: number; pitchDeg?: number; fovDeg?: number },
    ) => { heading: number; pitch: number; fov: number };
    exitCamera: () => void;
    setCamLook: (heading: number, pitch: number) => void;
    setCamFov: (fov: number) => void;
    setCamEyeHeight: (m: number) => void;
    setVerticalExaggeration: (v: number) => void;
    setSkySunDir: (x: number, y: number, z: number) => void;
    setPeaksVisible: (on: boolean) => void;
    setPeaksData: (data: Awaited<ReturnType<typeof loadAllMountains>>) => void;
    clearPeakSelection: () => void;
    getPeakSelection: () => { name: string; elevM: number; u: number; v: number }[]; // 書き出し用: 選択山の写真内正規化座標
    frameSelectView: (lon: number, lat: number, headingDeg: number) => void; // AR山選択: 撮影地点後方上空の俯瞰へ
    frameAimView: (lon: number, lat: number) => void; // AR向き決め: 撮影地点中心の北上俯瞰へ
    setControlMode: (mode: "map" | "aim" | "orbit") => void; // 地図操作: 通常 / 向き決め / 回転のみ
    setViewCone: (lon: number, lat: number, headingDeg: number, fovDeg: number) => void; // 視野コーン表示
    hideViewCone: () => void;
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
  // 山頂マーカー表示（既定オン。初回有効化時に山岳データを遅延ロード）。
  const [showPeaks, setShowPeaks] = useState(PEAKS_DEFAULT_ON);
  const peaksLoadedRef = useRef(false);
  // 選択中（色＋名前表示）の山の数。0より大きいとき画面に一括解除チップを出す。
  const [peakSelCount, setPeakSelCount] = useState(0);
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
  // 写真オーバーレイ（カメラ視点に撮影画像を重ね、手動で位置合わせ）。M1=重ね描画のみ。
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoOpacity, setPhotoOpacity] = useState(0.5);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  // ARウィザードのフェーズ: 写真→撮影地点→撮影情報→向き合わせ→山選択→書き出し。
  const [arStep, setArStep] = useState<ArStep>("upload");
  const [arLoc, setArLoc] = useState<{ lat: number; lon: number } | null>(null); // 撮影地点
  const [arHeadingDeg, setArHeadingDeg] = useState<number | null>(null); // 撮影方位（EXIF or ②で設定）
  const [arFovDeg, setArFovDeg] = useState(CAM_FOV_DEFAULT); // 横画角（EXIF or ②で設定）
  const [arPhotoAspect, setArPhotoAspect] = useState<number | null>(null); // 仕上げ画面の枠アスペクト用
  // 出力(仕上げ)で編集する各山ラベル。座標は写真フレーム内の正規化値(0..1)。
  const [arLabels, setArLabels] = useState<ArLabel[]>([]);
  const arStepRef = useRef<ArStep>("upload"); // ループから参照
  const arPinXZRef = useRef<{ x: number; z: number } | null>(null); // 撮影地点ピンのワールドXZ
  const arPinElRef = useRef<HTMLDivElement | null>(null); // 撮影地点ピンのDOM
  const arPhotoAspectRef = useRef<number | null>(null); // 撮影写真の縦横比(W/H)。3D枠の整形に使う
  const arPhotoElRef = useRef<HTMLImageElement | null>(null); // 写真オーバーレイのDOM（枠に追従）
  const arHudRef = useRef<HTMLDivElement | null>(null); // カメラHUD（下部パネル）。枠の予約高さ算出に使う
  const appModeRef = useRef(appMode); // ループから appMode を参照（マウント中は不変）
  const arEditStageRef = useRef<HTMLDivElement | null>(null); // 仕上げ画面の写真枠（座標換算用）
  const arDragRef = useRef<{ i: number; kind: "dot" | "label" } | null>(null); // ドラッグ中の対象
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
      MAP_FOV,
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

    // 山頂マーカー（全山頂に点。タップで選択＝色が橙→青。名前ラベルは全山に常時表示）。
    const peaks = new PeakMarkers();
    scene.add(peaks.points);
    // 山名ラベル（DOMオーバーレイ）。全山頂ぶんの要素を一度だけ作り、毎フレーム
    // 画面に映っているものだけ表示・配置する（画面外は display:none で軽量化）。
    const peakLabelLayer = document.createElement("div");
    peakLabelLayer.className = "peak-label-layer";
    mount.appendChild(peakLabelLayer);
    let peakLabelEls: HTMLDivElement[] = [];
    // データ投入時に全山頂のラベル要素を生成（既存があれば作り直し）。
    const buildPeakLabels = () => {
      peakLabelLayer.replaceChildren();
      peakLabelEls = new Array(peaks.count);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < peaks.count; i++) {
        const el = document.createElement("div");
        el.className = "peak-label";
        el.textContent = peaks.peakName(i);
        el.style.display = "none";
        frag.appendChild(el);
        peakLabelEls[i] = el;
      }
      peakLabelLayer.appendChild(frag);
    };
    const labelProj = new THREE.Vector3();
    // 毎フレーム、ラベルを画面へ追従。地図モードは全山名を表示、カメラ視点では選択した
    // 山だけ表示（未選択の点が隠れるのに合わせる）。画面外・カメラ後方は隠す。
    const updatePeakLabels = () => {
      if (!peakLabelEls.length) return;
      // AR微調整中は写真枠(rect)へ投影。それ以外は全画面。
      const rect = isArStage()
        ? arStageRect()
        : { x: 0, y: 0, w: mount.clientWidth, h: mount.clientHeight };
      const onlySelected = cameraMode; // カメラ視点では選択した山だけ
      for (let i = 0; i < peakLabelEls.length; i++) {
        const el = peakLabelEls[i];
        const sel = peaks.isSelected(i);
        // カメラ視点では未選択を隠す。太陽月モードの円盤クリップ外の山名も隠す。
        if ((onlySelected && !sel) || peaks.isHiddenByClip(i)) {
          if (el.style.display !== "none") el.style.display = "none";
          continue;
        }
        labelProj.copy(peaks.worldPos(i)).project(camera);
        const onScreen =
          labelProj.z <= 1 &&
          labelProj.x >= -1.05 && labelProj.x <= 1.05 &&
          labelProj.y >= -1.05 && labelProj.y <= 1.05;
        if (onScreen) {
          el.style.display = "block";
          el.style.left = `${rect.x + (labelProj.x * 0.5 + 0.5) * rect.w}px`;
          el.style.top = `${rect.y + (-labelProj.y * 0.5 + 0.5) * rect.h}px`;
          if (sel !== el.classList.contains("is-selected")) el.classList.toggle("is-selected", sel);
        } else if (el.style.display !== "none") {
          el.style.display = "none";
        }
      }
    };

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
    const tapNDC = new THREE.Vector2(); // タップのNDC（AR撮影地点レイ用）
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // 地形に当たらない時の代用
    const planeHit = new THREE.Vector3();
    const DOWN = new THREE.Vector3(0, -1, 0);
    const rayOrigin = new THREE.Vector3();
    const reticleWorld = new THREE.Vector3();
    const arPinWorld = new THREE.Vector3(); // AR撮影地点ピンの投影用
    const sampleSurfaceY = (x: number, z: number): number => {
      // 観測点の上空から真下へレイし、表示中の地形メッシュ表面の高さを得る。
      rayOrigin.set(x, 9000, z);
      camRay.set(rayOrigin, DOWN);
      const hits = camRay.intersectObjects(terrain.group.children, false);
      return hits.length ? hits[0].point.y : 0;
    };

    // AR微調整/書き出し中、写真と3Dの「写る範囲」を一致させる枠（CSS px, 左上原点）。
    // 写真のアスペクト比で、上の進行表示と下のパネルを避けた領域に内接させる。
    const AR_TOP_RESERVE = 46;
    const arStageRect = () => {
      const W = mount.clientWidth;
      const H = mount.clientHeight;
      const panelH = (arHudRef.current?.offsetHeight ?? 150) + 24;
      const availH = Math.max(80, H - AR_TOP_RESERVE - panelH);
      const aspect = arPhotoAspectRef.current ?? W / Math.max(1, H);
      let w = W;
      let h = w / aspect;
      if (h > availH) {
        h = availH;
        w = h * aspect;
      }
      return { x: (W - w) / 2, y: AR_TOP_RESERVE + (availH - h) / 2, w, h };
    };
    // AR微調整/書き出しで写真枠に合わせて描画するか。
    const isArStage = () =>
      appModeRef.current === "ar" &&
      (arStepRef.current === "align" || arStepRef.current === "export") &&
      arPhotoAspectRef.current != null;

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

    // --- AR向き決め: 撮影地点から「写る方向・範囲」を示す視野コーン（扇形）を地図上に描く --- //
    const VIEWCONE_SEGS = 28;
    const VIEWCONE_R = 90; // コーンの長さ(world)
    const viewConeGeom = new THREE.BufferGeometry();
    const viewConePos = new Float32Array((VIEWCONE_SEGS + 2) * 3); // 扇形(apex + 弧)を三角扇で
    viewConeGeom.setAttribute("position", new THREE.BufferAttribute(viewConePos, 3));
    const viewConeIdx: number[] = [];
    for (let i = 1; i <= VIEWCONE_SEGS; i++) viewConeIdx.push(0, i, i + 1);
    viewConeGeom.setIndex(viewConeIdx);
    const viewCone = new THREE.Mesh(
      viewConeGeom,
      new THREE.MeshBasicMaterial({
        color: 0x5fa0e6,
        transparent: true,
        opacity: 0.32,
        depthTest: false,
        side: THREE.DoubleSide,
      }),
    );
    viewCone.renderOrder = 998;
    viewCone.frustumCulled = false;
    viewCone.visible = false;
    scene.add(viewCone);
    // コーンの縁（中心線＋外周）を線で強調。
    const viewConeEdgeGeom = new THREE.BufferGeometry();
    const viewConeEdgePos = new Float32Array((VIEWCONE_SEGS + 3) * 3);
    viewConeEdgeGeom.setAttribute("position", new THREE.BufferAttribute(viewConeEdgePos, 3));
    const viewConeEdge = new THREE.Line(
      viewConeEdgeGeom,
      new THREE.LineBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.95, depthTest: false }),
    );
    viewConeEdge.renderOrder = 999;
    viewConeEdge.frustumCulled = false;
    viewConeEdge.visible = false;
    scene.add(viewConeEdge);
    // 視野コーンを撮影地点・方向・画角に合わせて作り直す。
    const updateViewCone = (ex: number, ez: number, headingDeg: number, fovDeg: number) => {
      const base = sampleSurfaceY(ex, ez) + 3; // 地表より少し上に浮かせて見やすく
      const half = (Math.min(Math.max(fovDeg, 1), 175) / 2) * (Math.PI / 180);
      const h0 = (headingDeg * Math.PI) / 180;
      // コーンの長さは今のズーム（カメラ距離）に比例＝俯瞰の画面内にだいたい収まる。
      const R = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 0.55, 12, VIEWCONE_R);
      viewConePos[0] = ex;
      viewConePos[1] = base;
      viewConePos[2] = ez;
      for (let i = 0; i <= VIEWCONE_SEGS; i++) {
        const a = h0 - half + (2 * half * i) / VIEWCONE_SEGS; // 方位角（0=北=-Z）
        const x = ex + R * Math.sin(a);
        const z = ez - R * Math.cos(a);
        const o = (i + 1) * 3;
        viewConePos[o] = x;
        viewConePos[o + 1] = base;
        viewConePos[o + 2] = z;
      }
      viewConeGeom.attributes.position.needsUpdate = true;
      viewConeGeom.computeBoundingSphere();
      // 縁: apex→弧開始→…→弧終端→apex
      viewConeEdgePos[0] = ex;
      viewConeEdgePos[1] = base;
      viewConeEdgePos[2] = ez;
      for (let i = 0; i <= VIEWCONE_SEGS; i++) {
        const o = (i + 1) * 3;
        viewConeEdgePos[o] = viewConePos[(i + 1) * 3];
        viewConeEdgePos[o + 1] = base;
        viewConeEdgePos[o + 2] = viewConePos[(i + 1) * 3 + 2];
      }
      const last = (VIEWCONE_SEGS + 2) * 3;
      viewConeEdgePos[last] = ex;
      viewConeEdgePos[last + 1] = base;
      viewConeEdgePos[last + 2] = ez;
      viewConeEdgeGeom.attributes.position.needsUpdate = true;
      viewConeEdgeGeom.computeBoundingSphere();
      viewCone.visible = true;
      viewConeEdge.visible = true;
    };

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
          peaks.setClipDisk(null, 0); // 山頂点・ラベルのクリップも解除
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
      enterCamera: (eyeHeightM, override) => {
        // override あり（写真のGPS）＝その地点へ即着地。なし＝今の地図中心に立つ。
        if (override) {
          cam.eyeX = mercXToWorld(lonToMercX(override.lon));
          cam.eyeZ = mercYToWorld(latToMercY(override.lat));
          // 地図へ戻った時にGPS地点を見渡せるよう、復帰ポーズもその地点に向ける。
          const gps = new THREE.Vector3(cam.eyeX, 0, cam.eyeZ);
          mapPose = { pos: gps.clone().add(new THREE.Vector3(0, 2200, 2600)), target: gps };
        } else {
          mapPose = { pos: camera.position.clone(), target: controls.target.clone() };
          cam.eyeX = controls.target.x;
          cam.eyeZ = controls.target.z;
        }
        // 地表のワールドYを実標高(m)に戻して保持（VEX変更にも追従できる）。
        cam.groundElevM = sampleSurfaceY(cam.eyeX, cam.eyeZ) / Math.max(1e-9, elevToWorldY(1));
        cam.eyeHeightM = eyeHeightM;
        if (override?.headingDeg != null) {
          cam.heading = ((override.headingDeg % 360) + 360) % 360; // EXIF撮影方位
        } else {
          camera.getWorldDirection(dirTmp); // 初期方位＝今の水平向き
          cam.heading = ((Math.atan2(dirTmp.x, -dirTmp.z) * 180) / Math.PI + 360) % 360;
        }
        cam.pitch =
          override?.pitchDeg != null
            ? THREE.MathUtils.clamp(override.pitchDeg, -CAM_PITCH_LIMIT, CAM_PITCH_LIMIT) // 復帰時の仰角
            : 0;
        cam.fov =
          override?.fovDeg != null
            ? THREE.MathUtils.clamp(override.fovDeg, CAM_FOV_MIN, CAM_FOV_MAX) // EXIF焦点距離由来
            : CAM_FOV_DEFAULT;
        terrain.setClip(null, 0); // 円盤クリップ解除（カメラ視点は切り抜かない）
        peaks.setClipDisk(null, 0); // 山頂点・ラベルのクリップも解除（カメラ視点は全山対象）
        peaks.setCameraMode(true); // カメラ視点では選択(青)の山頂だけ残し、未選択(橙)は隠す
        cameraMode = true;
        controls.enabled = false;
        return { heading: cam.heading, pitch: cam.pitch, fov: cam.fov };
      },
      exitCamera: () => {
        cameraMode = false;
        peaks.setCameraMode(false); // 地図に戻ったら未選択(橙)の山頂も再表示
        controls.enabled = true;
        if (mapPose) {
          camera.position.copy(mapPose.pos);
          controls.target.copy(mapPose.target);
          mapPose = null;
        }
        camera.fov = MAP_FOV; // 地図モードは縦画角 MAP_FOV に戻す
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
        peaks.refreshY(); // 山頂マーカーの高さも新しい誇張率へ
      },
      setSkySunDir: (x, y, z) => sunDirWorld.set(x, y, z),
      setPeaksVisible: (on) => {
        peaks.setVisible(on);
        peakLabelLayer.style.display = on ? "block" : "none"; // 非表示時はラベルも隠す（選択は保持）
      },
      setPeaksData: (data) => {
        peaks.setData(data);
        buildPeakLabels(); // 全山頂ぶんの名前ラベル要素を作る
      },
      clearPeakSelection: () => {
        peaks.clearSelection(); // ラベルの選択強調は次フレームの updatePeakLabels で反映
      },
      // AR山選択: 撮影地点（＝注視点）を中心に、その後ろ上空から heading 方向を見下ろす俯瞰へ。
      // 引きすぎず撮影地点が分かる距離。パンは別途ロックして場所が動かないようにする。
      frameSelectView: (lon, lat, headingDeg) => {
        const ex = mercXToWorld(lonToMercX(lon));
        const ez = mercYToWorld(latToMercY(lat));
        const h = sampleSurfaceY(ex, ez);
        const hr = (headingDeg * Math.PI) / 180;
        const fx = Math.sin(hr); // 前方(heading)の水平成分（X=東, Z=南, 北=-Z）
        const fz = -Math.cos(hr);
        const BACK = 42; // 撮影地点の後ろへ引く距離(world)。引きすぎない
        const UP = 34; // 上空へ上げる高さ(world)
        controls.target.set(ex, h, ez); // 注視点＝撮影地点そのもの
        camera.position.set(ex - fx * BACK, h + UP, ez - fz * BACK);
        camera.up.set(0, 1, 0);
        flyGoal = null; // 進行中の fly を止める
        controls.update();
      },
      // 撮影地点の「ほぼ真上」へ（少し南に倒して北を上に）。今のズーム距離は保ったまま
      // flyGoal でフライトのように滑らかに移動。真上にすると向き（コンパス）が読みやすい。
      frameAimView: (lon, lat) => {
        const ex = mercXToWorld(lonToMercX(lon));
        const ez = mercYToWorld(latToMercY(lat));
        const h = sampleSurfaceY(ex, ez);
        // 現在のズームを維持しつつ、極端に引きすぎ/寄りすぎは適度に収める。
        const dist = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target), 12, 160);
        const polar = THREE.MathUtils.degToRad(8); // 真上から8°だけ南へ（北上＆真上の特異点回避）
        camera.up.set(0, 1, 0);
        flyGoal = {
          pos: new THREE.Vector3(ex, h + dist * Math.cos(polar), ez + dist * Math.sin(polar)),
          target: new THREE.Vector3(ex, h, ez),
        };
      },
      // 地図操作モード: map=通常 / aim=向き決め(ドラッグで方向、回転パン無効) / orbit=山選択(回転のみ)。
      setControlMode: (mode) => {
        controls.enableZoom = true;
        controls.enablePan = mode === "map";
        controls.enableRotate = mode !== "aim";
        const rotateOnLeft = mode === "orbit"; // 山選択は左ドラッグ=回転
        controls.mouseButtons.LEFT = rotateOnLeft ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
        controls.touches.ONE = rotateOnLeft ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
      },
      setViewCone: (lon, lat, headingDeg, fovDeg) => {
        updateViewCone(mercXToWorld(lonToMercX(lon)), mercYToWorld(latToMercY(lat)), headingDeg, fovDeg);
      },
      hideViewCone: () => {
        viewCone.visible = false;
        viewConeEdge.visible = false;
      },
      // 書き出し用: 選択中の山頂を写真フレーム内の正規化座標(u,v ∈ 0..1)で返す。
      // AR微調整中はカメラが写真アスペクトで投影しているため、NDC がそのまま写真の位置になる。
      getPeakSelection: () => {
        const out: { name: string; elevM: number; u: number; v: number }[] = [];
        for (const i of peaks.selected) {
          projTmp.copy(peaks.worldPos(i)).project(camera);
          if (projTmp.z > 1) continue; // カメラ後方は除外
          out.push({
            name: peaks.peakName(i),
            elevM: peaks.peakElev(i),
            u: projTmp.x * 0.5 + 0.5,
            v: -projTmp.y * 0.5 + 0.5,
          });
        }
        return out;
      },
    };

    // 既定で山頂表示ON。初回マウント時に山岳データを遅延ロードして点・ラベルを出す。
    if (PEAKS_DEFAULT_ON) {
      peaksLoadedRef.current = true;
      apiRef.current.setPeaksVisible(true);
      loadAllMountains().then((data) => apiRef.current?.setPeaksData(data));
    }

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
        // 1本指＝向き（ズーム(小fov)ほど感度を下げる）。実際の縦画角(camera.fov)基準。
        const degPerPx = camera.fov / mount.clientHeight;
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

    // --- 山頂タップ選択（地図・カメラ両モード共通）。ドラッグと区別するため移動量で判定 --- //
    let tapId = -1;
    let tapX = 0;
    let tapY = 0;
    let tapMoved = false;
    const onTapDown = (e: PointerEvent) => {
      tapId = e.pointerId;
      tapX = e.clientX;
      tapY = e.clientY;
      tapMoved = false;
    };
    const onTapMove = (e: PointerEvent) => {
      if (e.pointerId !== tapId) return;
      if (Math.hypot(e.clientX - tapX, e.clientY - tapY) > 6) tapMoved = true; // パン/回転とみなす
    };
    const onTapUp = (e: PointerEvent) => {
      if (e.pointerId !== tapId) return;
      tapId = -1;
      if (tapMoved) return; // パン/回転とみなす
      const rect = renderer.domElement.getBoundingClientRect();
      // AR撮影地点フェーズ: タップ地点を地形にレイキャストして撮影地点に置く。
      if (arStepRef.current === "locate") {
        tapNDC.set(
          ((e.clientX - rect.left) / mount.clientWidth) * 2 - 1,
          -((e.clientY - rect.top) / mount.clientHeight) * 2 + 1,
        );
        camRay.setFromCamera(tapNDC, camera);
        const hits = camRay.intersectObjects(terrain.group.children, false);
        let wx: number | null = null;
        let wz: number | null = null;
        if (hits.length) {
          wx = hits[0].point.x;
          wz = hits[0].point.z;
        } else if (camRay.ray.intersectPlane(groundPlane, planeHit)) {
          wx = planeHit.x; // 地形に当たらなければ海面で代用
          wz = planeHit.z;
        }
        if (wx != null && wz != null) {
          arPinXZRef.current = { x: wx, z: wz };
          setArLoc(worldToLonLat(wx, wz));
        }
        return;
      }
      if (!peaks.points.visible) return;
      const i = peaks.pick(e.clientX - rect.left, e.clientY - rect.top, camera, mount.clientWidth, mount.clientHeight);
      if (i == null) return;
      peaks.toggle(i); // 色(橙↔青)が変わる。ラベルの選択強調は次フレームで反映
      setPeakSelCount(peaks.selectedCount);
    };
    renderer.domElement.addEventListener("pointerdown", onTapDown);
    window.addEventListener("pointermove", onTapMove);
    window.addEventListener("pointerup", onTapUp);
    window.addEventListener("pointercancel", onTapUp);

    // --- AR向き決めフェーズ: 地図をドラッグして撮影方向を指す（撮影地点→カーソルの方位） --- //
    let aiming = false;
    const aimFromEvent = (e: PointerEvent) => {
      const eye = arPinXZRef.current;
      if (!eye) return;
      const rect = renderer.domElement.getBoundingClientRect();
      tapNDC.set(
        ((e.clientX - rect.left) / mount.clientWidth) * 2 - 1,
        -((e.clientY - rect.top) / mount.clientHeight) * 2 + 1,
      );
      camRay.setFromCamera(tapNDC, camera);
      const hits = camRay.intersectObjects(terrain.group.children, false);
      let wx: number, wz: number;
      if (hits.length) {
        wx = hits[0].point.x;
        wz = hits[0].point.z;
      } else if (camRay.ray.intersectPlane(groundPlane, planeHit)) {
        wx = planeHit.x;
        wz = planeHit.z;
      } else return;
      const dx = wx - eye.x;
      const dz = wz - eye.z;
      if (dx * dx + dz * dz < 1e-4) return;
      setArHeadingDeg((((Math.atan2(dx, -dz) * 180) / Math.PI) + 360) % 360); // 0=北
    };
    const onAimDown = (e: PointerEvent) => {
      if (arStepRef.current !== "params") return;
      aiming = true;
      aimFromEvent(e);
    };
    const onAimMove = (e: PointerEvent) => {
      if (aiming && arStepRef.current === "params") aimFromEvent(e);
    };
    const onAimUp = () => (aiming = false);
    renderer.domElement.addEventListener("pointerdown", onAimDown);
    window.addEventListener("pointermove", onAimMove);
    window.addEventListener("pointerup", onAimUp);
    window.addEventListener("pointercancel", onAimUp);

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
        // cam.fov は「横画角」。AR微調整中は写真枠のアスペクト比で換算＝横の写る範囲が写真と一致。
        // それ以外は全画面アスペクト。縦画角はアスペクトに追従。
        const arStage = isArStage();
        const stageRect = arStage ? arStageRect() : null;
        const aspect = stageRect
          ? stageRect.w / Math.max(1, stageRect.h)
          : mount.clientWidth / Math.max(1, mount.clientHeight);
        const vFov = THREE.MathUtils.radToDeg(
          2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / aspect),
        );
        if (Math.abs(camera.fov - vFov) > 1e-3 || Math.abs(camera.aspect - aspect) > 1e-4) {
          camera.fov = vFov;
          camera.aspect = aspect;
          camera.updateProjectionMatrix();
        }
        // 写真オーバーレイDOMを枠にぴったり合わせる（3D描画と同じ矩形）。
        if (arStage && stageRect && arPhotoElRef.current) {
          const s = arPhotoElRef.current.style;
          s.left = `${stageRect.x}px`;
          s.top = `${stageRect.y}px`;
          s.width = `${stageRect.w}px`;
          s.height = `${stageRect.h}px`;
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
        updatePeakLabels(); // 山名ラベルを画面へ追従（地図=全山 / カメラ=選択のみ）
        if (arStage && stageRect) {
          // 写真枠だけに3Dを描画し、外側は暗いレターボックスに（写真と範囲を一致）。
          const W = mount.clientWidth;
          const H = mount.clientHeight;
          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, W, H);
          renderer.clear();
          const glY = H - (stageRect.y + stageRect.h);
          renderer.setViewport(stageRect.x, glY, stageRect.w, stageRect.h);
          renderer.setScissor(stageRect.x, glY, stageRect.w, stageRect.h);
          renderer.setScissorTest(true);
          renderer.autoClear = false;
          renderer.render(scene, camera);
          renderer.autoClear = true;
          renderer.setScissorTest(false);
        } else {
          renderer.setViewport(0, 0, mount.clientWidth, mount.clientHeight);
          renderer.render(scene, camera);
        }
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
          peaks.setClipDisk({ x: tx, z: tz }, diskR); // 円盤の外の山頂点・ラベルを隠す
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
      updatePeakLabels(); // 山名ラベルを画面へ追従（地図=全山 / カメラ=選択のみ）

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

      // AR撮影地点ピン（撮影地点フェーズのみ）。タップ/検索で置いた地点を地表に追従表示。
      const arPinEl = arPinElRef.current;
      if (arPinEl) {
        const pxz = arPinXZRef.current;
        if (arStepRef.current === "locate" && pxz) {
          arPinWorld.set(pxz.x, sampleSurfaceY(pxz.x, pxz.z), pxz.z);
          projTmp.copy(arPinWorld).project(camera);
          if (projTmp.z <= 1) {
            arPinEl.style.display = "block";
            arPinEl.style.left = `${(projTmp.x * 0.5 + 0.5) * mount.clientWidth}px`;
            arPinEl.style.top = `${(-projTmp.y * 0.5 + 0.5) * mount.clientHeight}px`;
          } else {
            arPinEl.style.display = "none";
          }
        } else {
          arPinEl.style.display = "none";
        }
      }

      renderer.setScissorTest(false); // AR枠描画の後でも地図は全画面に戻す
      renderer.setViewport(0, 0, mount.clientWidth, mount.clientHeight);
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
      renderer.domElement.removeEventListener("pointerdown", onTapDown);
      window.removeEventListener("pointermove", onTapMove);
      window.removeEventListener("pointerup", onTapUp);
      window.removeEventListener("pointercancel", onTapUp);
      renderer.domElement.removeEventListener("pointerdown", onAimDown);
      window.removeEventListener("pointermove", onAimMove);
      window.removeEventListener("pointerup", onAimUp);
      window.removeEventListener("pointercancel", onAimUp);
      ro.disconnect();
      apiRef.current = null;
      previewRing.geometry.dispose();
      (previewRing.material as THREE.Material).dispose();
      viewCone.geometry.dispose();
      (viewCone.material as THREE.Material).dispose();
      viewConeEdge.geometry.dispose();
      (viewConeEdge.material as THREE.Material).dispose();
      celestial.dispose();
      skyDome.dispose();
      peaks.dispose();
      peakLabelLayer.remove();
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

  // 写真オーバーレイの blob URL をアンマウント時に解放（メモリリーク防止）。
  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  // ARフェーズ・appMode をレンダリングループ用の ref に同期。
  useEffect(() => {
    arStepRef.current = arStep;
  }, [arStep]);
  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  // 撮影写真の縦横比(W/H)を読み、3D描画枠の整形に使う（ループから ref で参照）。
  useEffect(() => {
    if (!photoUrl) {
      arPhotoAspectRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      const a = img.naturalWidth / Math.max(1, img.naturalHeight);
      arPhotoAspectRef.current = a;
      setArPhotoAspect(a);
    };
    img.src = photoUrl;
  }, [photoUrl]);

  // 向き決め(②)・山選択(③)の俯瞰中、視野コーンを地図上に描画（写る方向の山を選びやすく）。
  useEffect(() => {
    if (appMode === "ar" && (arStep === "params" || arStep === "select") && arLoc) {
      apiRef.current?.setViewCone(arLoc.lon, arLoc.lat, arHeadingDeg ?? 0, arFovDeg);
    } else {
      apiRef.current?.hideViewCone();
    }
  }, [appMode, arStep, arLoc, arHeadingDeg, arFovDeg]);

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
    if (arStep === "locate") placeArPoint(r.lat, r.lon); // AR地点選択中なら検索先を撮影地点に
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
  const enterCameraMode = (
    override?: { lon: number; lat: number; headingDeg?: number; pitchDeg?: number; fovDeg?: number },
  ) => {
    if (freeLook) {
      setFreeLook(false);
      apiRef.current?.setFreeLook(false);
    }
    const init = apiRef.current?.enterCamera(camEyeHeight, override); // 地表高さは現在(地図VEX)で取得
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
    apiRef.current?.setControlMode("map"); // 地図は通常操作（パン可）に戻す
    setMode("map");
  };

  // === AR ウィザード（写真→撮影地点→撮影情報→合わせる） ===
  // 撮影地点を置く（タップ/検索 共通）。ピンのワールドXZ(ref)と緯度経度(state)を同時更新。
  const placeArPoint = (lat: number, lon: number) => {
    setArLoc({ lat, lon });
    arPinXZRef.current = { x: mercXToWorld(lonToMercX(lon)), z: mercYToWorld(latToMercY(lat)) };
  };
  // 「合わせる」フェーズへ: 撮影地点に着地し、向き・画角を初期化。
  const goAlign = (loc: { lat: number; lon: number }, headingDeg: number | null, fovDeg: number) => {
    setArStep("align");
    enterCameraMode({ lon: loc.lon, lat: loc.lat, headingDeg: headingDeg ?? undefined, fovDeg });
  };
  // 写真を選んだら EXIF を読み、揃っていれば一気に、欠けていれば必要なフェーズへ進む。
  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルを連続で選べるようリセット
    if (!file) return;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(URL.createObjectURL(file));
    const exif = await readPhotoExif(file);
    setArHeadingDeg(exif.headingDeg); // EXIF方位（あれば②でプリセット、なければ後で入力）
    const fov = exif.hFovDeg != null
      ? THREE.MathUtils.clamp(exif.hFovDeg, CAM_FOV_MIN, CAM_FOV_MAX)
      : CAM_FOV_DEFAULT;
    setArFovDeg(fov);
    if (exif.lat != null && exif.lon != null) {
      // EXIFに位置があってもスキップせず、推定地点へピンを置いて確認・微調整できるようにする。
      placeArPoint(exif.lat, exif.lon);
      apiRef.current?.flyTo({ lat: exif.lat, lon: exif.lon });
    }
    setArStep("locate"); // 位置の確認/指定フェーズへ（EXIFありは確認、なしは指定）
  };
  // 撮影地点フェーズの「ここで決定」: 向きと画角をざっくり決めるフェーズへ（常に）。
  const confirmArLocate = () => {
    if (!arLoc) return;
    apiRef.current?.frameAimView(arLoc.lon, arLoc.lat); // 撮影地点中心の北上俯瞰へ
    apiRef.current?.setControlMode("aim"); // ドラッグ＝方向。回転・パンは無効
    setArStep("params");
  };
  // 向き・画角フェーズの「次へ」: 決めた向き・画角で山選択(③)へ。
  const confirmArParams = () => {
    goSelectFromParams();
  };
  // 向き・画角(②)→ 撮影地点(①)へ戻る（位置を選び直せる）。
  const backToLocate = () => {
    if (!arLoc) return;
    apiRef.current?.setControlMode("map"); // パン可に戻す
    apiRef.current?.flyTo({ lat: arLoc.lat, lon: arLoc.lon }); // 撮影地点へ寄せる
    setArStep("locate");
  };
  // 山選択(③)→ 向き・画角(②)へ戻る。俯瞰のまま向き決め(コーン)へ。
  const backToParams = () => {
    if (!arLoc) return;
    apiRef.current?.frameAimView(arLoc.lon, arLoc.lat);
    apiRef.current?.setControlMode("aim");
    setArStep("params");
  };
  // 最初からやり直す（写真を外して写真選択フェーズへ）。
  const restartAr = () => {
    if (mode === "camera") exitCameraMode();
    apiRef.current?.setControlMode("map"); // 向き決め/山選択のロックを解除
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(null);
    setArLoc(null);
    arPinXZRef.current = null;
    setArHeadingDeg(null);
    setArFovDeg(CAM_FOV_DEFAULT);
    setArLabels([]);
    setArStep("upload");
  };
  // 向き・画角(②)→ 山選択(③)。撮影地点中心の俯瞰で、写る方向の山を奥行きつきで選ぶ。
  const goSelectFromParams = () => {
    if (!arLoc) return;
    apiRef.current?.frameSelectView(arLoc.lon, arLoc.lat, arHeadingDeg ?? 0);
    apiRef.current?.setControlMode("orbit"); // 場所は固定。回転・ズームのみ
    setArStep("select");
  };
  // 山選択(③)→ 微調整(④)。一人称へ。選んだ山名が写真に重なるので、見ながら合わせ込める。
  const goAlignFromSelect = () => {
    if (arLoc) goAlign(arLoc, arHeadingDeg ?? 0, arFovDeg);
  };
  // 微調整(④)→ 山選択(③)へ戻る。微調整した向き・画角を引き継いでから俯瞰へ。
  const backToSelect = () => {
    if (!arLoc) return;
    setArHeadingDeg(camHeading); // 微調整を反映
    setArFovDeg(camFov);
    exitCameraMode(); // 一人称→地図
    apiRef.current?.frameSelectView(arLoc.lon, arLoc.lat, camHeading);
    apiRef.current?.setControlMode("orbit");
    setArStep("select");
  };
  // 仕上げ(⑤)で編集した位置（arLabels）を写真に焼き込み、合成JPEGのデータURLを返す。
  const bakeComposite = async (): Promise<string | null> => {
    if (!photoUrl) return null;
    const img = new Image();
    img.src = photoUrl;
    await img.decode();
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, W, H);
    const fs = Math.max(13, Math.round(H * 0.024)); // 写真サイズに応じた文字サイズ
    ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "alphabetic";
    for (const lb of arLabels) {
      const dotX = lb.dotU * W;
      const dotY = lb.dotV * H;
      const text = `${lb.name} ${Math.round(lb.elevM)}m`;
      const tw = ctx.measureText(text).width;
      const padX = fs * 0.5;
      const padY = fs * 0.32;
      const chipH = fs + padY * 2;
      const chipW = tw + padX * 2;
      const cx = lb.labelU * W; // 名札の中心
      const cy = lb.labelV * H;
      // 引き出し線（名札の中心→点）
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = Math.max(1, fs * 0.06);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(dotX, dotY);
      ctx.stroke();
      // 点（白丸・小さめ。視認用に細い暗縁）
      ctx.beginPath();
      ctx.arc(dotX, dotY, Math.max(2.5, H * 0.009), 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = Math.max(1, H * 0.0016);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
      ctx.stroke();
      // チップ（名札。中心 = cx,cy）
      ctx.fillStyle = "rgba(40, 92, 152, 0.92)";
      ctx.beginPath();
      ctx.roundRect(cx - chipW / 2, cy - chipH / 2, chipW, chipH, 6);
      ctx.fill();
      // 文字
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(text, cx, cy + fs * 0.34);
    }
    return canvas.toDataURL("image/jpeg", 0.92);
  };
  // 微調整(④)→ 仕上げ(⑤)。選択山を写真フレーム内の正規化座標で取り、編集用に展開。
  const goExport = () => {
    const sel = apiRef.current?.getPeakSelection() ?? [];
    const labels: ArLabel[] = sel
      .filter((p) => p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1) // 写真枠内のみ
      .map((p) => ({
        name: p.name,
        elevM: p.elevM,
        dotU: p.u,
        dotV: p.v,
        labelU: p.u,
        labelV: Math.max(0.06, p.v - 0.12), // 名札は点の少し上を初期位置に
      }));
    setArLabels(labels);
    setArStep("export");
  };
  // 仕上げ(⑤)→ 微調整(④)へ戻る。
  const backToAlignFromExport = () => {
    setArStep("align");
  };
  // 編集後の位置で焼き込み、合成画像をダウンロード。
  const downloadComposite = async () => {
    const url = await bakeComposite();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = "gsi-ar.jpg";
    a.click();
  };
  // 仕上げ画面: 名札/点のドラッグ。座標は写真枠内の正規化値(0..1)で持つ。
  const onEditDown = (i: number, kind: "dot" | "label") => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    arDragRef.current = { i, kind };
  };
  const onEditMove = (e: React.PointerEvent) => {
    const d = arDragRef.current;
    const stage = arEditStageRef.current;
    if (!d || !stage) return;
    const r = stage.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setArLabels((prev) =>
      prev.map((lb, idx) =>
        idx !== d.i ? lb : d.kind === "dot" ? { ...lb, dotU: u, dotV: v } : { ...lb, labelU: u, labelV: v },
      ),
    );
  };
  const onEditUp = () => {
    arDragRef.current = null;
  };
  // 現在のモードの標高誇張を変更（モードごとに記憶）。
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
  // 横画角をスライダーで変更（スクロール/ピンチと同じ cam.fov を動かす）。1度単位で微調整。
  const changeCamFov = (deg: number) => {
    setCamFov(deg);
    apiRef.current?.setCamFov(deg);
  };
  const compass = (deg: number) => {
    const dirs = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
    return dirs[Math.round(((deg % 360) / 45)) % 8];
  };
  // 月相名（phase: 0=新月, 0.25=上弦, 0.5=満月, 0.75=下弦, 1=新月）。
  const moonPhaseName = (phase: number) => {
    if (phase < 0.03 || phase >= 0.97) return "新月";
    if (phase < 0.22) return "三日月";
    if (phase < 0.28) return "上弦の月";
    if (phase < 0.47) return "満ちる月（凸）";
    if (phase < 0.53) return "満月";
    if (phase < 0.72) return "欠ける月（凸）";
    if (phase < 0.78) return "下弦の月";
    return "有明月";
  };
  // スイッチ行（表示セクション用）。
  const switchRow = (label: string, checked: boolean, onChange: (b: boolean) => void) => (
    <label className="switch-row">
      <span>{label}</span>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );

  // 山頂マーカーの表示切替。初回 ON で山岳データを遅延ロードして流し込む。
  const togglePeaks = (on: boolean) => {
    setShowPeaks(on);
    if (on && !peaksLoadedRef.current) {
      peaksLoadedRef.current = true;
      loadAllMountains().then((data) => apiRef.current?.setPeaksData(data));
    }
    apiRef.current?.setPeaksVisible(on);
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

      {/* 写真オーバーレイ（カメラ視点でのみ。位置・サイズはループが写真枠に合わせる） */}
      {mode === "camera" && photoUrl && (
        <img
          ref={arPhotoElRef}
          className="photo-overlay"
          src={photoUrl}
          alt=""
          style={{ opacity: photoOpacity }}
        />
      )}

      {/* 写真取り込み input（モード非依存で1つだけ。地図/カメラ両方の入口から呼ぶ） */}
      <input ref={photoInputRef} type="file" accept="image/*" hidden onChange={onPickPhoto} />

      {/* ① 写真選択フェーズ */}
      {appMode === "ar" && arStep === "upload" && (
        <div className="ar-intro">
          <span className="ar-intro-icon">
            <IconImage size={34} />
          </span>
          <h2>写真に山名をのせる</h2>
          <p>
            撮った山の写真を選ぶと、その地点から見た山に名前を重ねられます。
            <br />
            位置情報（GPS）があれば自動で、無ければ撮影地点を選んでください。
          </p>
          <button className="ar-intro-pick" onClick={() => photoInputRef.current?.click()}>
            <IconImage size={16} />
            <span>写真を選ぶ</span>
          </button>
        </div>
      )}

      {/* AR進行表示（地点 → 向き画角 → 山選択 → 微調整 → 出力） */}
      {appMode === "ar" && arStep !== "upload" && (
        <div className="ar-steps">
          {(["locate", "params", "select", "align", "export"] as const).map((k, idx) => {
            const order: Record<string, number> = {
              locate: 0,
              params: 1,
              select: 2,
              align: 3,
              export: 4,
            };
            const cur = order[arStep];
            const cls = idx < cur ? "done" : idx === cur ? "active" : "todo";
            const label = { locate: "地点", params: "向き画角", align: "微調整", select: "山選択", export: "出力" }[k];
            return (
              <span key={k} className={`ar-step is-${cls}`}>
                <b>{idx + 1}</b>
                {label}
              </span>
            );
          })}
        </div>
      )}

      {/* ② 撮影地点フェーズ: 案内＋ピン＋決定バー */}
      {appMode === "ar" && arStep === "locate" && (
        <>
          <div className="ar-locate-hint">
            <IconPin size={15} />
            <span>
              {arLoc
                ? "この位置でよろしいですか？ ずれていれば地図をタップ／検索で調整できます"
                : "撮影地点を選んでください — 地図をタップ、またはメニュー（☰）で検索"}
            </span>
          </div>
          <div ref={arPinElRef} className="ar-pin" style={{ display: "none" }}>
            <IconPin size={30} />
          </div>
          <div className="ar-bottom-bar">
            <button className="ar-btn-sub" onClick={restartAr}>
              やり直す
            </button>
            <button className="ar-btn-main" disabled={!arLoc} onClick={confirmArLocate}>
              ここで決定
            </button>
          </div>
        </>
      )}

      {/* ⑤ 山選択フェーズ: 3D俯瞰地図で山頂をタップ選択（奥行きが分かる） */}
      {appMode === "ar" && arStep === "select" && (
        <>
          <div className="ar-locate-hint">
            <IconMountain size={15} />
            <span>
              写真に写る山をタップして選びます。ドラッグで回転、ホイール／ピンチでズーム（撮影地点は固定）
            </span>
          </div>
          {photoUrl && (
            <img className="ar-select-thumb" src={photoUrl} alt="撮影写真" title="撮影した写真" />
          )}
          <div className="ar-bottom-bar">
            <button className="ar-btn-sub" onClick={backToParams}>
              <IconChevron dir="left" size={14} />
              向き・画角
            </button>
            <span className="ar-select-count">選択 {peakSelCount} 山</span>
            <button className="ar-btn-main" onClick={goAlignFromSelect}>
              微調整へ
              <IconChevron dir="right" size={14} />
            </button>
          </div>
        </>
      )}

      {/* ③ 向き・画角フェーズ: 地図上の視野コーンで方向と画角を決める */}
      {appMode === "ar" && arStep === "params" && (
        <>
          <div className="ar-locate-hint">
            <IconPin size={15} />
            <span>地図をドラッグして撮影方向を指します。スライダーで画角（写る範囲）を調整。</span>
          </div>
          <div className="ar-aim-bar">
            <div className="ar-readout">
              <span>方向 {compass(arHeadingDeg ?? 0)} {Math.round(arHeadingDeg ?? 0)}°</span>
              <span>横画角 {Math.round(arFovDeg)}°</span>
            </div>
            <label className="ar-fov">
              <span>画角（望遠 ←→ 広角）</span>
              <input
                type="range"
                min={CAM_FOV_MIN}
                max={CAM_FOV_MAX}
                value={Math.round(arFovDeg)}
                onChange={(e) => setArFovDeg(Number(e.target.value))}
              />
            </label>
            <div className="ar-aim-actions">
              <button className="ar-btn-sub" onClick={backToLocate}>
                <IconChevron dir="left" size={14} />
                撮影地点
              </button>
              <button className="ar-btn-main" onClick={confirmArParams}>
                山を選ぶ
                <IconChevron dir="right" size={14} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* ⑤ 出力(仕上げ): 写真に名札・点を重ね、ドラッグで微調整してからダウンロード */}
      {appMode === "ar" && arStep === "export" && (
        <div className="ar-edit">
          <div
            className="ar-edit-stage"
            ref={arEditStageRef}
            style={
              {
                aspectRatio: String(arPhotoAspect ?? 1.5),
                "--ar": String(arPhotoAspect ?? 1.5),
              } as React.CSSProperties
            }
          >
            {photoUrl && <img className="ar-edit-photo" src={photoUrl} alt="" draggable={false} />}
            {/* 引き出し線（名札→点） */}
            <svg className="ar-edit-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
              {arLabels.map((lb, i) => (
                <line
                  key={i}
                  x1={lb.labelU * 100}
                  y1={lb.labelV * 100}
                  x2={lb.dotU * 100}
                  y2={lb.dotV * 100}
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {arLabels.map((lb, i) => (
              <div key={i}>
                <div
                  className="ar-edit-dot"
                  style={{ left: `${lb.dotU * 100}%`, top: `${lb.dotV * 100}%` }}
                  onPointerDown={onEditDown(i, "dot")}
                  onPointerMove={onEditMove}
                  onPointerUp={onEditUp}
                />
                <div
                  className="ar-edit-label"
                  style={{ left: `${lb.labelU * 100}%`, top: `${lb.labelV * 100}%` }}
                  onPointerDown={onEditDown(i, "label")}
                  onPointerMove={onEditMove}
                  onPointerUp={onEditUp}
                >
                  {lb.name} {Math.round(lb.elevM)}m
                </div>
              </div>
            ))}
          </div>
          <div className="ar-edit-bar">
            <button className="ar-btn-sub" onClick={backToAlignFromExport}>
              <IconChevron dir="left" size={14} />
              微調整
            </button>
            <span className="ar-edit-hint">
              {arLabels.length > 0
                ? `名札や点をドラッグで位置を微調整（${arLabels.length}件）`
                : "写真の枠内に山がありません。微調整で向きを合わせ直してください"}
            </span>
            <button
              className="ar-btn-main"
              disabled={arLabels.length === 0}
              onClick={downloadComposite}
            >
              <IconDownload size={15} />
              ダウンロード
            </button>
          </div>
        </div>
      )}

      {/* 中心レティクル（注視点＝画面中央の目印）。ARでは撮影地点ピンを使うので出さない。 */}
      {appMode === "simulation" && mode === "map" && showCenter && (
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

      {/* ホームへ戻る（左上・メニューの右） */}
      <button className="home-btn" title="ホーム画面へ戻る" aria-label="ホーム" onClick={onHome}>
        <IconHome size={18} />
      </button>

      {/* 地図⇄カメラ視点の切替（右上）。ARでは視点遷移をウィザードが担うので出さない。 */}
      {appMode === "simulation" && (
        <button
          className={`mode-toggle${mode === "camera" ? " is-camera" : ""}`}
          title={mode === "map" ? "カメラ視点：今見ている地点に立って見回す" : "地図に戻る"}
          onClick={mode === "map" ? () => enterCameraMode() : exitCameraMode}
        >
          {mode === "map" ? <IconCamera size={16} /> : <IconMap size={16} />}
          <span>{mode === "map" ? "カメラ視点" : "地図に戻る"}</span>
        </button>
      )}


      {/* 山頂選択の一括解除チップ（シミュレーションのみ。ARは選択フェーズのUIで扱う） */}
      {appMode === "simulation" && showPeaks && peakSelCount > 0 && (
        <button
          className="peak-clear"
          title="選択した山頂の色と名前表示をすべて解除"
          onClick={() => {
            apiRef.current?.clearPeakSelection();
            setPeakSelCount(0);
          }}
        >
          <IconMountain size={15} />
          <span>山頂 {peakSelCount} 選択中</span>
          <b>×すべて解除</b>
        </button>
      )}

      {/* カメラ視点モードのHUD（下）。AR書き出し中は隠す（合成パネルを前面に）。 */}
      {mode === "camera" && !(appMode === "ar" && arStep === "export") && (
        <div className="cam-hud" ref={arHudRef}>
          <div className="cam-readout">
            <span>方位 {compass(camHeading)} {Math.round(camHeading)}°</span>
            <span>仰角 {Math.round(camPitch)}°</span>
            <span>横画角 {Math.round(camFov)}°</span>
          </div>
          <label className="cam-eye">
            <span>目線高さ {camEyeHeight} m</span>
            <input
              type="range"
              min={-10}
              max={200}
              value={camEyeHeight}
              onChange={(e) => changeCamEyeHeight(Number(e.target.value))}
            />
          </label>
          {/* 横画角スライダー（1度単位で微調整。スクロール/ピンチと同じ値。シミュ・AR共通） */}
          <label className="cam-eye">
            <span>横画角 {Math.round(camFov)}°（望遠 ←→ 広角）</span>
            <input
              type="range"
              min={CAM_FOV_MIN}
              max={CAM_FOV_MAX}
              value={Math.round(camFov)}
              onChange={(e) => changeCamFov(Number(e.target.value))}
            />
          </label>
          {/* 写真オーバーレイ操作（ARモードのみ）: 未読込なら取り込み、読込済みなら不透明度＋解除 */}
          {appMode === "ar" && (
            <div className="cam-photo">
              {!photoUrl ? (
                <button className="cam-photo-pick" onClick={() => photoInputRef.current?.click()}>
                  <IconImage size={15} />
                  <span>写真を重ねて合わせる</span>
                </button>
              ) : (
                <div className="cam-photo-ctrl">
                  <label className="cam-photo-opacity">
                    <span>写真の不透明度 {Math.round(photoOpacity * 100)}%</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(photoOpacity * 100)}
                      onChange={(e) => setPhotoOpacity(Number(e.target.value) / 100)}
                    />
                  </label>
                  <button className="cam-photo-clear" title="別の写真でやり直す" onClick={restartAr}>
                    別の写真
                  </button>
                </div>
              )}
            </div>
          )}
          {/* シミュレーションの操作ヒント */}
          {appMode === "simulation" && (
            <div className="cam-hint">ドラッグで見回す ／ ホイール・ピンチで画角</div>
          )}
          {/* AR ④微調整: 選んだ山名を写真に重ねて見ながら合わせ込む */}
          {appMode === "ar" && arStep === "align" && (
            <div className="ar-phase-foot">
              <span className="cam-hint">
                選んだ山名が写真に重なります。ドラッグで向き・ピンチ/ホイールで画角を合わせ込む。
              </span>
              <div className="ar-phase-foot-row">
                <button className="ar-btn-sub" onClick={backToSelect}>
                  <IconChevron dir="left" size={14} />
                  山選択
                </button>
                <button className="ar-btn-main" onClick={goExport}>
                  仕上げ
                  <IconChevron dir="right" size={14} />
                </button>
              </div>
            </div>
          )}
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
          {switchRow("操作リモコン（右下）", showRemote, setShowRemote)}
          {switchRow("中心マーカー", showCenter, setShowCenter)}
          <label className="switch-row">
            <span>山頂マーカー</span>
            <input
              type="checkbox"
              className="switch"
              checked={showPeaks}
              onChange={(e) => togglePeaks(e.target.checked)}
            />
          </label>
          {switchRow("空のグラデーション", showSky, setShowSky)}
          <label className="slider-row">
            <span className="slider-label">
              標高の誇張（{mode === "camera" ? "カメラ" : "地図"}）
              <b>×{activeVex.toFixed(1)}</b>
              {activeVex === 1 ? " 実寸" : ""}
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
          <label className="switch-row">
            <span>太陽・月を表示</span>
            <input
              type="checkbox"
              className="switch"
              checked={celestialOn}
              onChange={(e) => toggleCelestial(e.target.checked)}
            />
          </label>

          {celestialOn && (
            <>
              <div className="datetime-row">
                <input
                  type="date"
                  className="dt-date"
                  value={dateStr}
                  onChange={(e) => setDateStr(e.target.value)}
                />
                <span className="dt-time">{hhmm}</span>
                <button className="dt-now" onClick={setSunNow}>
                  現在
                </button>
              </div>
              <input
                type="range"
                className="dt-slider"
                min={0}
                max={1439}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />

              {skyInfo && (
                <div className="sky-card">
                  <div className="sky-row">
                    <IconSun size={22} className="sky-ico sky-ico--sun" />
                    <div className="sky-info">
                      <div className="sky-name">太陽</div>
                      <div className="sky-sub">
                        方位 {compass(skyInfo.sun.azimuthDeg)} {skyInfo.sun.azimuthDeg.toFixed(0)}° ・ 高度{" "}
                        {skyInfo.sun.altitudeDeg.toFixed(0)}°
                        {!skyInfo.sun.visible && " ・ 地平線下"}
                      </div>
                    </div>
                  </div>
                  <div className="sky-row">
                    <IconMoonPhase fraction={skyInfo.moonFraction} waxing={skyInfo.moonWaxing} size={24} />
                    <div className="sky-info">
                      <div className="sky-name">
                        {moonPhaseName(skyInfo.moonPhase)}
                        <span className="sky-pct">照度 {(skyInfo.moonFraction * 100).toFixed(0)}%</span>
                      </div>
                      <div className="sky-sub">
                        方位 {compass(skyInfo.moon.azimuthDeg)} {skyInfo.moon.azimuthDeg.toFixed(0)}° ・ 高度{" "}
                        {skyInfo.moon.altitudeDeg.toFixed(0)}°
                        {!skyInfo.moon.visible && " ・ 地平線下"}
                      </div>
                    </div>
                  </div>
                  <div className="moon-cycle">
                    {Array.from({ length: 8 }, (_, i) => {
                      const p = i / 8;
                      const now = Math.round(skyInfo.moonPhase * 8) % 8 === i;
                      return (
                        <div key={i} className={`moon-cyc${now ? " is-now" : ""}`} title={moonPhaseName(p)}>
                          <IconMoonPhase fraction={(1 - Math.cos(2 * Math.PI * p)) / 2} waxing={p < 0.5} size={20} />
                        </div>
                      );
                    })}
                  </div>

                  <div className="sky-times">
                    日の出 {fmtTime(skyInfo.sunrise)} ・ 日の入 {fmtTime(skyInfo.sunset)}
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
          {/* 自由視点（リモコンの下）。ARでは機能しないので出さない。 */}
          {appMode === "simulation" && (
            <button
              className={`freelook-toggle${freeLook ? " is-active" : ""}`}
              title="自由視点：地図解像度・太陽・月を固定したまま視点だけ動かす。解除すると元の視点へ戻ります"
              onClick={toggleFreeLook}
            >
              {freeLook ? "自由視点：ON" : "自由視点"}
            </button>
          )}
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
