import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { QuadtreeTerrain } from "../terrain/QuadtreeTerrain";
import { CelestialLayer } from "../terrain/CelestialLayer";
import { SkyDome } from "../terrain/SkyDome";
import { PeakMarkers } from "../terrain/PeakMarkers";
import { loadAllMountains, loadMountainDescriptions } from "../lib/mountains";
import { computeSky, computeTrack, type SkyState, type SkyBody } from "../lib/celestial";
import {
  IconMountain,
  IconPin,
  IconDownload,
  IconHome,
  IconLocate,
  IconCamera,
  IconMap,
  IconSun,
  IconMoonPhase,
  IconImage,
  IconChevron,
  IconCube,
  IconGrid,
  IconEye,
  IconInfo,
  IconLink,
  IconCaret,
  IconMove,
  IconAll,
  IconPlus,
  IconMinus,
  IconSearch,
  IconCompass,
  IconLandscape,
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
  requestOrientationPermission,
  subscribeOrientation,
  startRearCamera,
  stopStream,
} from "../lib/sensors";
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
import type { Settings } from "../settings";
import { CARDS } from "../modeCards";
import {
  renderTerrainStamp,
  formatLatLonShort,
  type StampStyle,
  type StampOrientation,
} from "../lib/terrainStamp";

// 3Dビュー本体。Three.js のセットアップ、地図的なカメラ操作（MapControls＋画面ボタン）、
// 毎フレームのクアッドツリー更新、そして事前ロード（中心＋半径でオフライン保存）UI を持つ。

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
const CAM_FOV_MIN = 5; // 横画角の下限（望遠写真にも合わせられるよう小さめ）
const CAM_FOV_MAX = 110;
const CAM_PITCH_LIMIT = 80;
const CAM_EYE_DEFAULT = 1.6; // 目線高さ(m, 地表から)
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
  // terrain=地形 / celestial=太陽月 / ar=写真AR / live=カメラAR / offline=オフライン保存。
  appMode: "terrain" | "celestial" | "ar" | "live" | "offline";
  onHome: () => void; // ホーム画面へ戻る。
  settings: Settings; // 表示設定（ホームで変更）。マウント時の初期値として取り込む。
  initialTarget?: { lat: number; lon: number } | null; // 入場時にこの地点へフライト（図鑑→地形/太陽月 連携）。
};

// ARウィザードのフェーズ。
type ArStep = "upload" | "locate" | "params" | "align" | "select" | "export";

// 出力(仕上げ)で編集する山ラベル。dot=点、label=名札。座標は写真フレーム内の正規化値(0..1)。
type ArLabel = {
  id: number;
  name: string;
  elevM: number;
  dotU: number;
  dotV: number;
  labelU: number;
  labelV: number;
  description?: string; // 解説（日本語・長め）。キャプション・焼き込みに使う。
  descriptionShort?: string; // 解説（日本語・短め）。
  descriptionEn?: string; // 解説（英語・長め）。
  descriptionEnShort?: string; // 解説（英語・短め）。
  nameEn?: string; // 英名（例: Mt. Fuji）。
  labelAnchor?: "top" | "bottom" | "left" | "right"; // 引き出し線がラベルのどの辺から出るか（既定=下）。
  prefecture?: string; // 所在県（例: 山梨県/静岡県）。タグ「場所」に使う。
  tagsJa?: string[]; // タグ（日本語）。
  tagsEn?: string[]; // タグ（英語）。tagsJa と同じ並び。
  source?: string; // 参考URL
};

// 県名→英語（タグ「場所」の英語表示用）。「県/府/都」を除いたヘボン式。北海道は Hokkaido。
const PREF_EN: Record<string, string> = {
  北海道: "Hokkaido", 青森県: "Aomori", 岩手県: "Iwate", 宮城県: "Miyagi", 秋田県: "Akita",
  山形県: "Yamagata", 福島県: "Fukushima", 茨城県: "Ibaraki", 栃木県: "Tochigi", 群馬県: "Gunma",
  埼玉県: "Saitama", 千葉県: "Chiba", 東京都: "Tokyo", 神奈川県: "Kanagawa", 新潟県: "Niigata",
  富山県: "Toyama", 石川県: "Ishikawa", 福井県: "Fukui", 山梨県: "Yamanashi", 長野県: "Nagano",
  岐阜県: "Gifu", 静岡県: "Shizuoka", 愛知県: "Aichi", 三重県: "Mie", 滋賀県: "Shiga",
  京都府: "Kyoto", 大阪府: "Osaka", 兵庫県: "Hyogo", 奈良県: "Nara", 和歌山県: "Wakayama",
  鳥取県: "Tottori", 島根県: "Shimane", 岡山県: "Okayama", 広島県: "Hiroshima", 山口県: "Yamaguchi",
  徳島県: "Tokushima", 香川県: "Kagawa", 愛媛県: "Ehime", 高知県: "Kochi", 福岡県: "Fukuoka",
  佐賀県: "Saga", 長崎県: "Nagasaki", 熊本県: "Kumamoto", 大分県: "Oita", 宮崎県: "Miyazaki",
  鹿児島県: "Kagoshima", 沖縄県: "Okinawa",
};
const prefEn = (pref: string) =>
  pref.split("/").map((p) => PREF_EN[p.trim()] ?? p.trim().replace(/[県府都道]$/, "")).join(" / ");

// "#ffffff" / "#aabbcc" など hex を "r,g,b" に変換（rgba 生成用）。
const hexToRgb = (hex: string): string => {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16) || 0;
  const g = parseInt(m.slice(2, 4), 16) || 0;
  const b = parseInt(m.slice(4, 6), 16) || 0;
  return `${r},${g},${b}`;
};
// 文字色が暗色か（相対輝度<0.5）。影・パネル・タグの反対色を決めるのに使う。
const isDarkColor = (hex: string): boolean => {
  const [r, g, b] = hexToRgb(hex).split(",").map(Number);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
};
// 文字の縁取り影の色（暗色文字→白影 / 明色文字→黒影）。dark=明色文字時の黒影の濃さ。
const contrastShadow = (textColor: string, dark = 0.82): string =>
  isDarkColor(textColor) ? "rgba(255,255,255,0.5)" : `rgba(0,0,0,${dark})`;
// タグ（ピル）の背景（文字色の反対色・半透明）。
const tagBg = (textColor: string): string =>
  isDarkColor(textColor) ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.4)";

// 背景パネルの塗り色（文字色の反対色・半透明）。
type BgPanel = "none" | "translucent";
const panelFill = (textColor: string) =>
  isDarkColor(textColor) ? "rgba(255,255,255,0.55)" : "rgba(17,21,29,0.42)"; // 暗色文字→淡色 / 明色文字→濃色
const panelStroke = (textColor: string) => (isDarkColor(textColor) ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.14)");

// ふち（フェード）の S字イージング停止点。t=0(写真の縁,不透明)→t=1(内側,透明)。
// 線形だと両端で傾きが折れて「マッハバンド」になり、余白側の境界が浮く。
// smoothstep(3t²−2t³) で両端の傾きを 0 にし、折れ目を消す。
const FADE_STOPS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map((t) => ({
  t,
  a: 1 - (3 * t * t - 2 * t * t * t), // t=0→1（不透明）, t=1→0（透明）
}));

// ラベルの内容パターン（1段目=主名／2段目=補足の組み合わせ）。
type LabelMode = "jaSubEnElev" | "jaSubEn" | "jaSubElev" | "enSubElev" | "jaOnly" | "enOnly";

// 焼き込み文字の役割（サイズ・フォントを役割ごとに設定する単位）。
type FontRole = "labelName" | "labelSub" | "captionTitle" | "captionBody";
// フォントは和文・欧文をセットにした「ペア」で選ぶ。
type FontPairId = "gothic" | "roundedGothic" | "modernGothic" | "mincho" | "posterMincho" | "brush";
type FontPair = { label: string; jp: string; en: string; description: string };
// 役割ごとにフォントペアを1つ持つ。
type RoleFonts = Record<FontRole, FontPairId>;

// 選べるフォントペア（和文＋欧文のセット。index.html で Google Fonts を読み込み）。
const FONT_PAIRS: Record<FontPairId, FontPair> = {
  gothic: { label: "ゴシック", jp: "Noto Sans JP", en: "Inter", description: "読みやすい標準フォント。本文・ラベル・注記向き。" },
  roundedGothic: { label: "丸ゴシック", jp: "M PLUS Rounded 1c", en: "Nunito", description: "丸みがあり、やさしく親しみやすい雰囲気。" },
  modernGothic: { label: "モダンゴシック", jp: "Zen Kaku Gothic New", en: "Montserrat", description: "現代的で力強い。カードUIや大きめタイトル向き。" },
  mincho: { label: "明朝", jp: "Noto Serif JP", en: "Noto Serif", description: "上品で落ち着いた雰囲気。観光ガイド風。" },
  posterMincho: { label: "ポスター明朝", jp: "Shippori Mincho", en: "Cormorant Garamond", description: "雑誌・ポスター風の高級感。共有画像のタイトル向き。" },
  brush: { label: "筆文字", jp: "Yuji Syuku", en: "Great Vibes", description: "和風で印象的。タイトル専用向き。" },
};
const FONT_PAIR_IDS = Object.keys(FONT_PAIRS) as FontPairId[];
// 初期フォント（全役割ともゴシック）。
const DEFAULT_ROLE_FONTS: RoleFonts = {
  labelName: "gothic",
  labelSub: "gothic",
  captionTitle: "gothic",
  captionBody: "gothic",
};
// 役割のフォントペアを canvas/CSS 用のファミリ指定に展開する。
// 欧文を先・和文を後に並べ、ラテン字は欧文フォント・CJKは和文フォントが当たるようにする。
const roleFontStack = (id: FontPairId) => {
  const p = FONT_PAIRS[id];
  return `"${p.en}", "${p.jp}", system-ui, sans-serif`;
};

export default function MapView({ appMode, onHome, settings, initialTarget }: MapViewProps) {
  // ar(写真)と live(カメラ) は、地点→向き→山選択→微調整 の流れを共有する（データ源だけ違う）。
  const arLike = appMode === "ar" || appMode === "live";
  const isSim = appMode === "terrain" || appMode === "celestial" || appMode === "offline"; // 3D地形ビュー系
  const simView = appMode === "terrain" || appMode === "celestial"; // 立って見回すビュー（カメラ視点あり）
  const showCelestial = appMode === "celestial"; // 太陽・月の表示＆操作
  const isOffline = appMode === "offline"; // オフライン保存モード
  const mountRef = useRef<HTMLDivElement | null>(null);
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
    setCamRoll: (deg: number) => void;
    setCamEyeHeight: (m: number) => void;
    setVerticalExaggeration: (v: number) => void;
    setSkySunDir: (x: number, y: number, z: number) => void;
    setPeaksVisible: (on: boolean) => void;
    setPeaksData: (data: Awaited<ReturnType<typeof loadAllMountains>>) => void;
    clearPeakSelection: () => void;
    getPeakSelection: () => { id: number; name: string; elevM: number; u: number; v: number }[]; // 書き出し用: 選択山の写真内正規化座標
    setControlMode: (mode: "map" | "aim" | "orbit") => void; // 地図操作: 通常 / 向き決め / 回転のみ
    // 地図(俯瞰)の2D(真上固定)/3D(傾け可)切替。center指定で撮影地点中心に寄せ、3Dはheading背後上空から見下ろす。
    setMapDimension: (dim: "2d" | "3d", center?: { lon: number; lat: number }, headingDeg?: number) => void;
    setViewCone: (lon: number, lat: number, headingDeg: number, fovDeg: number) => void; // 視野コーン（地形にドレープ）
    hideViewCone: () => void;
    stageZoom: (factor: number, clientX?: number, clientY?: number) => void; // ④⑤写真ビューのズーム（点指定可）
    stagePanBy: (dx: number, dy: number) => void; // ④⑤写真ビューのパン（画面px）
    resetStageView: () => void; // ④⑤写真ビューのズーム/パンを初期化
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
  // 地図(俯瞰)の2D/3D。2D=真上固定の地図、3D=傾けられる地形。カメラ視点には影響しない。
  // AR/ライブは向き決め・山選択を真上から行いたいので既定2D。シミュレーションは3D。
  const [map2D, setMap2D] = useState(arLike); // AR/ライブは2D既定、地形系は3D既定
  const map2DRef = useRef(arLike);
  // 表示設定はホームの「表示設定」パネルで変更し、ここではマウント時の初期値として取り込む。
  // 中心マーカー（視点中心＝画面中央の目印）。画面中央のレティクルで表示する。
  const [showCenter] = useState(settings.showCenter);
  // 空グラデーション表示。
  const [showSky] = useState(settings.showSky);
  const showSkyRef = useRef(settings.showSky);
  // 山頂マーカー表示（オン時は初回マウントで山岳データを遅延ロード）。
  const [showPeaks] = useState(settings.showPeaks);
  const peaksLoadedRef = useRef(false);
  // 選択中（色＋名前表示）の山の数。0より大きいとき画面に一括解除チップを出す。
  const [peakSelCount, setPeakSelCount] = useState(0);
  // 視点フリーモード（解像度・太陽月・円盤を凍結して視点だけ動かす）。
  const [freeLook, setFreeLook] = useState(false);
  // 標高の誇張（×1=実寸 1:1:1）。モードごとに既定が異なる（地図1.7 / カメラ1.0）。
  const [mapVex] = useState(settings.mapVex);
  const [camVex] = useState(settings.camVex);

  // --- カメラ視点モード（3Dマップを一人称カメラとして使う） --- //
  const [mode, setMode] = useState<"map" | "camera">("map");
  // 地図↔風景の切替時、暗転で「カメラの飛び＋地形の作り直し」を隠す（0=透明 / 1=暗転）。
  const [viewFade, setViewFade] = useState(0);
  // 暗転中の表示。種類で見た目を変える（モード開始=App側の大カード／ここは2種）:
  //   view = 地図⇄風景の小チップ / phase = AR③⇄④のステップバー。読み込み中は出さない。
  const [fadeInfo, setFadeInfo] = useState<
    | { kind: "view"; icon: React.ReactNode; name: string }
    | { kind: "phase"; step: number; name: string }
    | null
  >(null);
  const fadeBusyRef = useRef(false);
  const [camHeading, setCamHeading] = useState(0);
  const [camPitch, setCamPitch] = useState(0);
  const [camRoll, setCamRoll] = useState(0); // 水平の傾き補正（ロール）。AR微調整で使用
  const [camFov, setCamFov] = useState(CAM_FOV_DEFAULT);
  const [camEyeHeight, setCamEyeHeight] = useState(CAM_EYE_DEFAULT);
  // 写真オーバーレイ（カメラ視点に撮影画像を重ね、手動で位置合わせ）。M1=重ね描画のみ。
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoOpacity, setPhotoOpacity] = useState(0.5);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  // ARウィザードのフェーズ: 写真→撮影地点→撮影情報→向き合わせ→山選択→書き出し。
  // ライブAR（カメラ）は写真取込が無いので地点(locate)から開始。
  const [arStep, setArStep] = useState<ArStep>(appMode === "live" ? "locate" : "upload");
  const [arLoc, setArLoc] = useState<{ lat: number; lon: number } | null>(null); // 撮影地点
  const [arPhotoLoc, setArPhotoLoc] = useState<{ lat: number; lon: number } | null>(null); // 写真EXIFのGPS位置（あれば「写真の位置に戻す」用）
  const [arHeadingDeg, setArHeadingDeg] = useState<number | null>(null); // 撮影方位（EXIF or ②で設定）
  const [arFovDeg, setArFovDeg] = useState(CAM_FOV_DEFAULT); // 横画角（EXIF or ②で設定）
  // 出力(仕上げ)で編集する各山ラベル。座標は写真フレーム内の正規化値(0..1)。
  const [arLabels, setArLabels] = useState<ArLabel[]>([]);
  // 下部キャプション（スクショ風の解説帯）で取り上げる山。arLabels内のindex。
  const [captionIdx, setCaptionIdx] = useState(0);
  // 解説キャプションの言語: 日本語のみ / 英語のみ / 両方 / なし。
  const [captionLang, setCaptionLang] = useState<"ja" | "en" | "both" | "none">("ja");
  const bakeCaption = captionLang !== "none"; // 解説を焼き込むか
  // 仕上げ(⑤)の操作モード: image=写真をパン/ズーム / edit=ラベル・解説を移動。誤操作を防ぐ。
  const [arExportMode, setArExportMode] = useState<"image" | "edit">("edit");
  // 解説ブロックの幅（写真幅に対する割合）。4辺のハンドルでアスペクト比を調整（文字サイズは固定）。
  const [captionW, setCaptionW] = useState(0.55);
  const capResizeRef = useRef<{
    side: "l" | "r" | "t" | "b";
    startW: number;
    startV: number;
    boxLeft: number;
    boxRight: number;
  } | null>(null);
  // 両方表示のときの日英の分割比（左=日本語の割合）。間の線をドラッグで調整。
  const [captionSplit, setCaptionSplit] = useState(0.5);
  // 両方表示のときの日英の並べ方（横=左右2カラム / 縦=上下に積む）。
  const [captionLayout, setCaptionLayout] = useState<"horizontal" | "vertical">("horizontal");
  // 両方表示のときの見出し（タイトル）の出し方。
  //  each   … 各本文の上にその言語の見出し（現状）
  //  groupV … 日英の見出しを上下にまとめる（上=日が大きめ、下=英が小さめ）→その下に両本文
  //  groupH … 日英の見出しを左右にまとめる（左=日が大きめ、右=英が小さめ）→その下に両本文
  //  ja     … 日本語の見出しだけを上に→その下に両本文
  //  en     … 英語の見出しだけを上に→その下に両本文
  const [captionTitleMode, setCaptionTitleMode] = useState<"each" | "groupV" | "groupH" | "ja" | "en">("each");
  // 解説本文の長さ（長め=元の解説 / 短め=ショート版）。
  const [captionLength, setCaptionLength] = useState<"long" | "short">("long");
  // 選択中の長さに応じた解説本文を返す（短めが無ければ長めにフォールバック）。
  const descJa = (lb: { description?: string; descriptionShort?: string }) =>
    captionLength === "short" ? lb.descriptionShort || lb.description : lb.description;
  const descEn = (lb: { descriptionEn?: string; descriptionEnShort?: string }) =>
    captionLength === "short" ? lb.descriptionEnShort || lb.descriptionEn : lb.descriptionEn;
  // 山名と本文の間に差し込むタグ。高さ・場所・タグリストから任意に選ぶ（既定OFF）。
  const [capShowElev, setCapShowElev] = useState(false);
  const [capShowLoc, setCapShowLoc] = useState(false);
  const [capSelectedTags, setCapSelectedTags] = useState<string[]>([]); // 選択中の日本語タグ
  const toggleCapTag = (t: string) =>
    setCapSelectedTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  // 指定言語のチップ文字列を組み立てる（高さ→場所→選択タグの順）。
  const capChips = (lb: ArLabel, lang: "ja" | "en"): string[] => {
    const chips: string[] = [];
    if (capShowElev) chips.push(`${Math.round(lb.elevM).toLocaleString()}m`);
    if (capShowLoc && lb.prefecture)
      chips.push(lang === "en" ? prefEn(lb.prefecture) : lb.prefecture.replace(/\//g, "・"));
    const tj = lb.tagsJa ?? [];
    const te = lb.tagsEn ?? [];
    tj.forEach((t, i) => {
      if (capSelectedTags.includes(t)) chips.push(lang === "en" ? te[i] ?? t : t);
    });
    return chips;
  };
  // 解説プレビュー用の派生値（両方表示時の見出し構成）。焼き込み側のロジックと一致させる。
  const capItem = arLabels[captionIdx];
  const capBoth = captionLang === "both" && !!capItem?.description && !!capItem?.descriptionEn;
  const capName = capItem?.name ?? "";
  const capNameEn = capItem?.nameEn || capItem?.name || "";
  // 各本文に自前の見出しを付けるか（本文ごと、または単一言語のとき）。
  const capColHasTitle = !capBoth || captionTitleMode === "each";
  // タグ言語: 英語本文のときだけ英語、両方・日本語は日本語。
  const capTagLang: "ja" | "en" = captionLang === "en" ? "en" : "ja";
  // 共有見出しモードでタグが続くか（見出しの下マージン制御に使う）。
  const capSharedHasTags = !!capItem && capChips(capItem, capTagLang).length > 0;
  // タグ（ピル）プレビュー。指定言語のチップを並べる。空なら null。
  const capTagEls = (lang: "ja" | "en") => {
    if (!capItem) return null;
    const chips = capChips(capItem, lang);
    if (!chips.length) return null;
    return (
      <div className="ar-cap-tags">
        {chips.map((c, i) => (
          <span key={i} className="ar-cap-tag">{c}</span>
        ))}
      </div>
    );
  };
  // 共有見出しの構成（両方かつ each 以外）。sub=true は小さめ表示。row=左右並び。
  const capSharedTitleParts: { text: string; sub: boolean }[] = !capBoth
    ? []
    : captionTitleMode === "ja"
      ? [{ text: capName, sub: false }]
      : captionTitleMode === "en"
        ? [{ text: capNameEn, sub: false }]
        : captionTitleMode === "groupV" || captionTitleMode === "groupH"
          ? [{ text: capName, sub: false }, { text: capNameEn, sub: true }]
          : []; // each
  const capSharedRow = captionTitleMode === "groupH";
  // 山名ラベルを写真に焼き込むか（既定ON）。
  const [bakeLabels, setBakeLabels] = useState(true);
  // ラベルの内容パターン（1段目=主名／2段目=補足の組み合わせ）。
  //  jaSubEnElev … 日本語名 ＋（英語名 | 標高）  ※現状
  //  jaSubEn     … 日本語名 ＋ 英語名
  //  jaSubElev   … 日本語名 ＋ 標高
  //  enSubElev   … 英語名 ＋ 標高
  //  jaOnly      … 日本語名のみ
  //  enOnly      … 英語名のみ
  const [labelMode, setLabelMode] = useState<LabelMode>("jaSubEnElev");
  // ラベルの1段目（name）と2段目（sub）の文字列を labelMode から決める。sub が空なら1段目のみ。
  const labelContent = (lb: { name: string; nameEn?: string; elevM: number }) => {
    const ja = lb.name;
    const en = lb.nameEn || lb.name;
    const elev = `${Math.round(lb.elevM).toLocaleString()}m`;
    switch (labelMode) {
      case "jaOnly":
        return { name: ja, sub: "" };
      case "enOnly":
        return { name: en, sub: "" };
      case "jaSubElev":
        return { name: ja, sub: elev };
      case "enSubElev":
        return { name: en, sub: elev };
      case "jaSubEn":
        return { name: ja, sub: en };
      default: // jaSubEnElev（現状）
        return { name: ja, sub: `${lb.nameEn ? lb.nameEn + " | " : ""}${elev}` };
    }
  };
  const labelHasSub = labelMode !== "jaOnly" && labelMode !== "enOnly";
  // ラベルの実寸（正規化）。引き出し線をラベルの上下左右どの辺から出すか計算するのに使う。
  const [labelBoxes, setLabelBoxes] = useState<Record<number, { w: number; h: number }>>({});
  // 選択枠（::before）の余白（正規化）。点を枠の辺上に置くために加える。横=1.2cqmax / 縦=0.8cqmax。
  const [labelFramePad, setLabelFramePad] = useState<{ h: number; v: number }>({ h: 0, v: 0 });
  const [measureTick, setMeasureTick] = useState(0); // ステージのサイズ確定/変化時に計測をやり直すトリガー
  // 引き出し線がラベルの選んだ辺（選択枠の辺）の中点から出る座標（正規化）。
  const labelSidePoint = (i: number) => {
    const lb = arLabels[i];
    const box = labelBoxes[i] ?? { w: 0, h: 0 };
    const { h: ph, v: pv } = labelFramePad;
    const anchor = lb?.labelAnchor ?? "bottom";
    const c = photoToFrame(lb.labelU, lb.labelV); // 写真座標 → フレーム座標（辺オフセットはフレーム単位）
    if (anchor === "top") return { x: c.u, y: c.v - box.h - pv };
    if (anchor === "left") return { x: c.u - box.w / 2 - ph, y: c.v - box.h / 2 };
    if (anchor === "right") return { x: c.u + box.w / 2 + ph, y: c.v - box.h / 2 };
    return { x: c.u, y: c.v + pv }; // bottom（枠の下辺）
  };
  // 文字サイズ倍率（スライダーで連続調整）。役割ごとに独立。初期値はすべて 1.0。
  //  labelNameScale    … ラベル1段目（山名）のサイズ。0.7〜2.0
  //  labelSubScale     … ラベル2段目（Mt.ローマ字｜標高）のサイズ。0.7〜1.6
  //  captionTitleScale … 解説タイトルのサイズ。0.7〜2.0
  //  captionBodyScale  … 解説本文（＋出典）のサイズ。0.7〜1.6
  // 役割ごとの実サイズはテンプレート側で base × scale と計算する。
  const [labelNameScale, setLabelNameScale] = useState(1);
  const [labelSubScale, setLabelSubScale] = useState(1);
  const [captionTitleScale, setCaptionTitleScale] = useState(1);
  const [captionBodyScale, setCaptionBodyScale] = useState(1);
  // 役割ごとのフォントペア（和文＋欧文セット）。山名/補足/タイトル/本文で個別に指定できる。
  const [roleFonts, setRoleFonts] = useState<RoleFonts>(DEFAULT_ROLE_FONTS);
  const setRoleFont = (role: FontRole, value: FontPairId) =>
    setRoleFonts((p) => ({ ...p, [role]: value }));
  // 役割のフォント選択行（和文＋欧文をまとめて選ぶ1セレクト）。選択中ペアの説明を下に出す。
  const fontRow = (role: FontRole, label: string) => (
    <>
      <div className="ar-fs-row">
        <span>{label}</span>
        <div className="ar-font-sel">
          <select value={roleFonts[role]} onChange={(e) => setRoleFont(role, e.target.value as FontPairId)} aria-label={label}>
            {FONT_PAIR_IDS.map((id) => (
              <option key={id} value={id} title={FONT_PAIRS[id].description}>
                {FONT_PAIRS[id].label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="ar-font-desc">{FONT_PAIRS[roleFonts[role]].description}</p>
    </>
  );
  // 文字色。ラベルと解説で別々。
  const [labelColor, setLabelColor] = useState("#ffffff");
  const [captionColor, setCaptionColor] = useState("#ffffff");
  // 文字の縁取り影（ありなし）。ラベルと解説で別々。
  const [labelShadow, setLabelShadow] = useState(true);
  const [captionShadow, setCaptionShadow] = useState(true);
  // タグ（ピル）の色と、その色を背景／文字どちらに使うか。
  const [tagColor, setTagColor] = useState("#d6b46a");
  const [tagColorTarget, setTagColorTarget] = useState<"bg" | "text">("bg");
  // タグの塗り分け。背景に使うとき＝文字は可読な反対色／文字に使うとき＝背景は反対色の半透明。
  const pillColors = () =>
    tagColorTarget === "bg"
      ? { bg: tagColor, fg: isDarkColor(tagColor) ? "rgba(255,255,255,0.95)" : "rgba(0,0,0,0.85)" }
      : { bg: tagBg(tagColor), fg: tagColor };
  // 背景パネル（なし / 半透明 / 不透明）。ラベルと解説で別々。背景色は文字色の反対色。
  const [labelBg, setLabelBg] = useState<BgPanel>("none");
  const [captionBg, setCaptionBg] = useState<BgPanel>("none");
  // フレーム（仕上げ）。切り抜き(crop)＋余白(margin)＋ふちグラデーション。出力枠基準・既定は無効。
  const [cropInset, setCropInset] = useState({ l: 0, t: 0, r: 0, b: 0 }); // 写真の各辺を内側へ切り抜く割合
  const [frameMargin, setFrameMargin] = useState({ t: 0, r: 0, b: 0, l: 0 }); // 余白（切り抜き後の辺長に対する割合）
  const [frameMarginColor, setFrameMarginColor] = useState("#ffffff"); // 余白の色（白/黒）
  const [frameFade, setFrameFade] = useState(0); // ふち：余白のある辺で写真を余白色へぼかす幅（切り抜き後の辺長に対する割合）
  // 3Dミニマップ・スタンプ（写真ARの仕上げで写真の隅に焼き込む）。既定はオフ。
  const [stampOn, setStampOn] = useState(false);
  const [stampStyle, setStampStyle] = useState<StampStyle>("contour");
  const [stampCorner, setStampCorner] = useState<"br" | "bl" | "tr" | "tl">("br");
  const [stampRangeKm, setStampRangeKm] = useState(5);
  const [stampAccent, setStampAccent] = useState("#d6b46a");
  const [stampShowInfo, setStampShowInfo] = useState(true);
  const [stampOrient, setStampOrient] = useState<StampOrientation>("heading");
  // プレビュー用のスタンプ画像（PNG dataURL）と山情報。書き出しは bakeComposite で都度再生成。
  const [stampPreview, setStampPreview] = useState<{
    url: string;
    mountain: { id?: number; name: string; lat: number; lon: number; elevationM: number } | null;
    oriented: boolean;
  } | null>(null);
  // 解説ブロックの配置（写真フレーム内の正規化座標。ブロック左上）。ドラッグで移動。
  const [captionPos, setCaptionPos] = useState({ u: 0.05, v: 0.62 });
  const captionDragRef = useRef<{ offU: number; offV: number } | null>(null); // 解説ドラッグの掴み位置
  const arStepRef = useRef<ArStep>(appMode === "live" ? "locate" : "upload"); // ループから参照
  const arLocRef = useRef<{ lat: number; lon: number } | null>(null); // 撮影地点（2D/3D切替の中心に使う）
  const arHeadingRef = useRef<number | null>(null); // 撮影方位（3D俯瞰の背後角に使う。toggleで再発火させたくないのでref）
  const arPinXZRef = useRef<{ x: number; z: number } | null>(null); // 撮影地点ピンのワールドXZ
  const [modePanelOpen, setModePanelOpen] = useState(true); // celestial/offline の専用パネルの折り畳み
  const [dockTab, setDockTab] = useState<Record<string, string>>({}); // パネルごとに選択中タブID（縦折りたたみ→タブ化）
  const arPinElRef = useRef<HTMLDivElement | null>(null); // 撮影地点ピンのDOM（先端を地表に接地）
  const arPhotoAspectRef = useRef<number | null>(null); // 撮影写真の縦横比(W/H)。3D枠の整形に使う
  const arPhotoElRef = useRef<HTMLImageElement | null>(null); // 写真オーバーレイのDOM（枠に追従）
  const arHudRef = useRef<HTMLDivElement | null>(null); // カメラHUD（下部パネル）。枠の予約高さ算出に使う
  // 写真枠が予約するパネル高さ。フェーズ開始時・画面リサイズ時にだけ更新し、
  // セクションの折りたたみ/パネル移動では更新しない（写真がそれに追従しないように）。
  const arPanelReserveRef = useRef(150);
  const appModeRef = useRef(appMode); // ループから appMode を参照（マウント中は不変）
  const arEditStageRef = useRef<HTMLDivElement | null>(null); // 仕上げ画面の外枠（写真比・3D連動）
  const arFrameRef = useRef<HTMLDivElement | null>(null); // 出力枠（フレーム）。座標換算・cqmaxの基準
  const [photoNat, setPhotoNat] = useState<{ w: number; h: number } | null>(null); // 写真の自然サイズ（出力枠アスペクト計算用）
  // フレーム（出力枠）プレビュー幾何。既定（切り抜き0・余白0）では 枠=写真 と一致。
  const fCwF = Math.max(0.1, 1 - cropInset.l - cropInset.r);
  const fChF = Math.max(0.1, 1 - cropInset.t - cropInset.b);
  const fMlr = frameMargin.l + frameMargin.r;
  const fMtb = frameMargin.t + frameMargin.b;
  const fAnyMargin = fMtb > 0 || fMlr > 0;
  // 点・ラベル・解説の座標は「写真（切り抜き前の元写真）正規化」で保持する。
  // クロップ/余白で写真がフレーム内を動いても山頂の点が追従するよう、描画時にフレーム座標へ変換する。
  // 既定（切り抜き0・余白0）では恒等変換（写真=フレーム）。
  const photoToFrame = (pu: number, pv: number) => ({
    u: (frameMargin.l + (pu - cropInset.l) / fCwF) / (1 + fMlr),
    v: (frameMargin.t + (pv - cropInset.t) / fChF) / (1 + fMtb),
  });
  // 逆変換（ドラッグ＝フレーム座標 → 保持する写真座標）。
  const frameToPhoto = (fu: number, fv: number) => ({
    u: cropInset.l + (fu * (1 + fMlr) - frameMargin.l) * fCwF,
    v: cropInset.t + (fv * (1 + fMtb) - frameMargin.t) * fChF,
  });
  const fPhotoAR = photoNat ? photoNat.w / photoNat.h : 1;
  const frameAR = fPhotoAR * (fCwF / fChF) * ((1 + fMlr) / (1 + fMtb)); // 出力枠アスペクト
  const framePhotoStyle: React.CSSProperties = {
    position: "absolute",
    left: `${(frameMargin.l / (1 + fMlr)) * 100}%`,
    top: `${(frameMargin.t / (1 + fMtb)) * 100}%`,
    width: `${(1 / (1 + fMlr)) * 100}%`,
    height: `${(1 / (1 + fMtb)) * 100}%`,
    overflow: "hidden",
  };
  const frameCropImgStyle: React.CSSProperties = {
    position: "absolute",
    width: `${(1 / fCwF) * 100}%`,
    height: `${(1 / fChF) * 100}%`,
    left: `${(-cropInset.l / fCwF) * 100}%`,
    top: `${(-cropInset.t / fChF) * 100}%`,
  };
  // ふち（フェード）。余白のある辺だけ、写真領域の内側へ frameFade ぶん余白色へ溶かす。
  const fadeStyle = (dir: "t" | "b" | "l" | "r"): React.CSSProperties | null => {
    if (frameFade <= 0 || frameMargin[dir] <= 0) return null;
    const rgb = hexToRgb(frameMarginColor);
    const pct = `${frameFade * 100}%`;
    // S字イージングの停止点で、写真の縁（不透明）→内側（透明）をなめらかに繋ぐ。
    const stops = FADE_STOPS.map(({ t, a }) => `rgba(${rgb},${a.toFixed(3)}) ${(t * 100).toFixed(1)}%`).join(", ");
    const grad = (toDir: string) => `linear-gradient(${toDir}, ${stops})`;
    const base: React.CSSProperties = { position: "absolute", pointerEvents: "none" };
    if (dir === "t") return { ...base, left: 0, right: 0, top: 0, height: pct, background: grad("to bottom") };
    if (dir === "b") return { ...base, left: 0, right: 0, bottom: 0, height: pct, background: grad("to top") };
    if (dir === "l") return { ...base, top: 0, bottom: 0, left: 0, width: pct, background: grad("to right") };
    return { ...base, top: 0, bottom: 0, right: 0, width: pct, background: grad("to left") };
  };
  const arDragRef = useRef<{ i: number; kind: "dot" | "label" | "labelAnchor" | "caption" | "capResize" | "capSplit" } | null>(null); // ドラッグ中の対象
  // AR下部パネルの折りたたみ/移動（縦画像や地図を見やすくするため）。
  const [arPanelOpen, setArPanelOpen] = useState(true); // 折りたたみ（false=畳む）
  const [arDockOffset, setArDockOffset] = useState({ x: 0, y: 0 }); // ドックのドラッグ移動量(px)
  // ④⑤: 写真+3Dビューのズーム率（UI表示・−ボタン無効化用。実体はループ側closure）。
  const [photoZoom, setPhotoZoom] = useState(1);
  // ④微調整の操作モード: aim=ドラッグで向き合わせ / move=ドラッグで写真パン。
  const [arEditMode, setArEditMode] = useState<"aim" | "move">("aim");
  const arEditModeRef = useRef<"aim" | "move">("aim");
  // --- ライブAR（カメラでその場AR）専用 --- //
  const liveVideoRef = useRef<HTMLVideoElement | null>(null); // 背面カメラのライブ映像
  const liveStreamRef = useRef<MediaStream | null>(null); // 取得中のカメラストリーム（解放用）
  const liveOriUnsubRef = useRef<(() => void) | null>(null); // 方位センサ購読の解除
  const [liveCompassDeg, setLiveCompassDeg] = useState<number | null>(null); // コンパス方位の生値
  const [liveStatus, setLiveStatus] = useState<string | null>(null); // GPS/センサ/カメラの状態メッセージ
  // 方位センサ追従のON/OFF。ONで②の向きがコンパスに追従、OFFで固定（手動で微調整可）。
  const [liveFollow, setLiveFollow] = useState(true);

  // --- 太陽・月 --- //
  // 太陽月は celestial モードで常時ON（トグル廃止＝モードで決まる）。
  const celestialOn = showCelestial;
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
  // 共有リンク（地形・太陽月のみ）。今見ている中心の座標を入れたURLにしてコピーする。
  const [shareCopied, setShareCopied] = useState(false);
  const shareTimerRef = useRef(0);
  const canShare = appMode === "terrain" || appMode === "celestial"; // フェーズのあるAR系は対象外
  const shareCurrentView = async () => {
    const c = apiRef.current?.getCenter();
    let hash = `#/${appMode}`;
    if (c) hash += `?lat=${c.lat.toFixed(5)}&lon=${c.lon.toFixed(5)}`;
    history.replaceState(null, "", location.pathname + location.search + hash);
    try {
      await navigator.clipboard.writeText(location.href);
      setShareCopied(true);
      window.clearTimeout(shareTimerRef.current);
      shareTimerRef.current = window.setTimeout(() => setShareCopied(false), 1600);
    } catch {
      window.prompt("このリンクをコピーしてください", location.href);
    }
  };
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
      // near=0.0002(≒0.2m)。世界座標は1単位=1kmなので 0.05 だと約50mより手前の地形が
      // ニア面で切り取られ、足元（手前）が抜けてその下が透けて見えてしまう。
      // logarithmicDepthBuffer:true なので near を小さくしても深度精度は保てる。
      0.0002,
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

    // 標高の誇張はモジュール全体で共有する値。初期表示（地図モード）の設定値を反映してから地形を作る。
    applyVEX(mapVex);
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
    const cam = { heading: 0, pitch: 0, roll: 0, fov: CAM_FOV_DEFAULT, eyeX: 0, eyeZ: 0, groundElevM: 0, eyeHeightM: CAM_EYE_DEFAULT };
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
      // 重要: クアッドツリーは非表示の粗いLODタイルも prune まで group に残す。
      // three.js の raycast は visible を見ない（layers のみ）ため、何も対策しないと
      // 非表示の粗い面（表示面より高いことがある）に当たり、点が表示面からズレて浮く。
      // → 当たったうち「表示中(visible)」のタイル面だけを採用する。
      rayOrigin.set(x, 9000, z);
      camRay.set(rayOrigin, DOWN);
      const hits = camRay.intersectObjects(terrain.group.children, false);
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].object.visible) return hits[i].point.y;
      }
      return 0;
    };

    // 写真+3Dビューの「ユーザー操作による」ズーム(拡大率)とパン(移動量, 画面px)。
    // 初期配置は基準枠(baseStageRect)＝今までの自動配置。以後はこの2値をユーザーが操作する。
    let stageScale = 1; // 1=画面内に収まる初期サイズ。>1で拡大（画面より大きくなる）
    const stagePan = { x: 0, y: 0 }; // 基準中心からの移動量(px)
    const STAGE_SCALE_MIN = 1;
    const STAGE_SCALE_MAX = 6;

    // 基準枠（contain）: 縦は中央だが、既定(下)パネルと重なるなら上へ寄せる。
    // パネルの折り畳み(offsetHeight)には追従するが、ドラッグ移動には追従しない（resting footprint）。
    const baseStageRect = () => {
      const W = mount.clientWidth;
      const H = mount.clientHeight;
      const aspect = arPhotoAspectRef.current ?? W / Math.max(1, H);
      let w = W;
      let h = w / aspect;
      if (h > H) {
        h = H;
        w = h * aspect;
      }
      const gap = 8;
      const panelTop = H - (arPanelReserveRef.current + 24 + gap);
      let y = (H - h) / 2;
      if (y + h > panelTop) y = Math.max(0, panelTop - h);
      return { x: (W - w) / 2, y, w, h };
    };
    // ユーザーのズーム+パンを適用した実枠。画面外に飛ばないよう中心をクランプし、
    // クランプ結果を stagePan に書き戻す（ドラッグの不感帯を防ぐ）。
    const arStageRect = () => {
      const b = baseStageRect();
      const W = mount.clientWidth;
      const H = mount.clientHeight;
      const w = b.w * stageScale;
      const h = b.h * stageScale;
      const baseCx = b.x + b.w / 2;
      const baseCy = b.y + b.h / 2;
      let cx = baseCx + stagePan.x;
      let cy = baseCy + stagePan.y;
      // 中心の可動域: 写真が画面より大きい時は画面を覆う範囲、小さい時は画面内に収まる範囲。
      const cxLo = Math.min(w / 2, W - w / 2);
      const cxHi = Math.max(w / 2, W - w / 2);
      const cyLo = Math.min(h / 2, H - h / 2);
      const cyHi = Math.max(h / 2, H - h / 2);
      cx = Math.max(cxLo, Math.min(cxHi, cx));
      cy = Math.max(cyLo, Math.min(cyHi, cy));
      stagePan.x = cx - baseCx;
      stagePan.y = cy - baseCy;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    };
    // 画面上の点(sx,sy)を固定したままズーム（null=画面中央）。ボタンは中央、ホイール/ピンチはカーソル基準。
    const stageZoomAt = (factor: number, sx: number | null, sy: number | null) => {
      const b = baseStageRect();
      const baseCx = b.x + b.w / 2;
      const baseCy = b.y + b.h / 2;
      const s0 = stageScale;
      const s1 = THREE.MathUtils.clamp(s0 * factor, STAGE_SCALE_MIN, STAGE_SCALE_MAX);
      if (Math.abs(s1 - s0) < 1e-4) return;
      const ax = sx ?? mount.clientWidth / 2;
      const ay = sy ?? mount.clientHeight / 2;
      const k = s1 / s0;
      const cx0 = baseCx + stagePan.x;
      const cy0 = baseCy + stagePan.y;
      stageScale = s1;
      stagePan.x = ax + (cx0 - ax) * k - baseCx;
      stagePan.y = ay + (cy0 - ay) * k - baseCy;
      setPhotoZoom(s1);
    };
    const stagePanBy = (dx: number, dy: number) => {
      stagePan.x += dx;
      stagePan.y += dy; // クランプは arStageRect 側で実施
    };
    const resetStageView = () => {
      stageScale = 1;
      stagePan.x = 0;
      stagePan.y = 0;
      setPhotoZoom(1);
    };
    // AR微調整/書き出しで写真枠に合わせて描画するか。
    const isArStage = () =>
      (appModeRef.current === "ar" || appModeRef.current === "live") &&
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
      new THREE.LineBasicMaterial({ color: 0xd6b46a, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    previewRing.renderOrder = 999;
    previewRing.visible = false;
    scene.add(previewRing);

    // --- AR向き決め: 撮影地点から「写る方向・範囲」を示す視野コーン（扇形）--- //
    // 真のデカール方式: 地形マテリアルのフラグメントシェーダで「このピクセルは扇の内側か」を
    // 判定して地表テクスチャに色を重ねる（QuadtreeTerrain.setViewCone）。地形に完全追従し、
    // 浮き・サンプル誤差・z-fight が原理的に無い。更新は uniform 書き換えのみで軽い。
    const VIEWCONE_R = 180; // コーンの長さ(world)の上限。
    const updateViewCone = (ex: number, ez: number, headingDeg: number, fovDeg: number) => {
      const half = (Math.min(Math.max(fovDeg, 1), 175) / 2) * (Math.PI / 180);
      const dir = (headingDeg * Math.PI) / 180;
      // 長さはズーム連動だが、方向が分かるよう遠くまで伸ばす（外周は透過するので長くてOK）。
      const R = THREE.MathUtils.clamp(camera.position.distanceTo(controls.target) * 2.2, 40, VIEWCONE_R);
      terrain.setViewCone({ x: ex, z: ez, dir, half, radius: R });
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
    let pending2DLock = false; // 2Dへのフライト完了後に真上固定(クランプ)を掛けるための予約
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
      setCamRoll: (deg) => {
        cam.roll = deg;
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
      // 地図操作モード: map=通常 / aim=向き決め(ドラッグで方向、回転パン無効) / orbit=山選択(回転のみ)。
      setControlMode: (mode) => {
        controls.enableZoom = true;
        controls.enablePan = mode === "map";
        // 2D(真上固定)のときは回転(傾け)させない。3Dのときのみモードに従う。
        controls.enableRotate = map2DRef.current ? false : mode !== "aim";
        const rotateOnLeft = mode === "orbit" && !map2DRef.current; // 山選択は左ドラッグ=回転
        controls.mouseButtons.LEFT = rotateOnLeft ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
        controls.touches.ONE = rotateOnLeft ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
      },
      // 地図(俯瞰)の2D/3D切替。フライト（滑らかな傾き移動）で行う。
      // 2D=真上固定で傾け不可、3D=俯瞰角へ傾けて自由回転。
      // center を渡すと撮影地点中心に寄せ直す（フェーズ間の専用フライトは廃し、2D/3D切替がフライトを兼ねる）。
      // 3Dは headingDeg の背後上空から見下ろす（撮影者の背中側＝写る方向が奥）。
      setMapDimension: (dim, center, headingDeg) => {
        map2DRef.current = dim === "2d";
        camera.up.set(0, 1, 0);
        // 中心: center指定があれば撮影地点、なければ現在の注視点を維持。
        let cx = controls.target.x;
        let cy = controls.target.y;
        let cz = controls.target.z;
        if (center) {
          cx = mercXToWorld(lonToMercX(center.lon));
          cz = mercYToWorld(latToMercY(center.lat));
          cy = sampleSurfaceY(cx, cz);
        }
        const target = new THREE.Vector3(cx, cy, cz);
        // 現在のズームを維持。撮影地点に寄せ直す時だけ極端な引き/寄りを適度に収める。
        let dist = camera.position.distanceTo(controls.target);
        if (center) dist = THREE.MathUtils.clamp(dist, 12, 160);
        // 飛行中はクランプを外す（外さないとスナップして飛行にならない）。
        controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
        if (dim === "2d") {
          controls.enableRotate = false;
          pending2DLock = true; // 飛行完了後に真上固定を掛ける
          flyGoal = { pos: new THREE.Vector3(cx, cy + dist, cz), target };
        } else {
          controls.enableRotate = true;
          pending2DLock = false;
          const polar = THREE.MathUtils.degToRad(55); // 俯瞰角
          const horiz = dist * Math.sin(polar);
          if (typeof headingDeg === "number") {
            const hr = (headingDeg * Math.PI) / 180;
            const fx = Math.sin(hr); // 前方(heading)の水平成分（X=東, Z=南, 北=-Z）
            const fz = -Math.cos(hr);
            flyGoal = {
              pos: new THREE.Vector3(cx - fx * horiz, cy + dist * Math.cos(polar), cz - fz * horiz),
              target,
            };
          } else {
            flyGoal = { pos: new THREE.Vector3(cx, cy + dist * Math.cos(polar), cz + horiz), target };
          }
        }
      },
      setViewCone: (lon, lat, headingDeg, fovDeg) => {
        updateViewCone(mercXToWorld(lonToMercX(lon)), mercYToWorld(latToMercY(lat)), headingDeg, fovDeg);
      },
      hideViewCone: () => {
        terrain.setViewCone(null);
      },
      stageZoom: (factor, clientX, clientY) => {
        if (clientX == null || clientY == null) {
          stageZoomAt(factor, null, null); // 中央基準（ボタン）
          return;
        }
        const r = renderer.domElement.getBoundingClientRect();
        stageZoomAt(factor, clientX - r.left, clientY - r.top); // 点基準（ホイール）
      },
      stagePanBy: (dx, dy) => stagePanBy(dx, dy),
      resetStageView: () => resetStageView(),
      // 書き出し用: 選択中の山頂を写真フレーム内の正規化座標(u,v ∈ 0..1)で返す。
      // AR微調整中はカメラが写真アスペクトで投影しているため、NDC がそのまま写真の位置になる。
      getPeakSelection: () => {
        const out: { id: number; name: string; elevM: number; u: number; v: number }[] = [];
        for (const i of peaks.selected) {
          projTmp.copy(peaks.worldPos(i)).project(camera);
          if (projTmp.z > 1) continue; // カメラ後方は除外
          out.push({
            id: peaks.peakId(i),
            name: peaks.peakName(i),
            elevM: peaks.peakElev(i),
            u: projTmp.x * 0.5 + 0.5,
            v: -projTmp.y * 0.5 + 0.5,
          });
        }
        return out;
      },
    };

    // 設定で山頂表示ONなら、初回マウント時に山岳データを遅延ロードして点・ラベルを出す。
    if (showPeaks) {
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
        const d = pinchDistance();
        if (appModeRef.current !== "ar" && appModeRef.current !== "live") {
          // 地形系: 2本指ピンチ＝画角。
          if (pinchDist > 0 && d > 0) {
            cam.fov = THREE.MathUtils.clamp(cam.fov * (pinchDist / d), CAM_FOV_MIN, CAM_FOV_MAX);
            setCamFov(cam.fov);
          }
        } else if (arStepRef.current === "align" && pinchDist > 0 && d > 0) {
          // AR/ライブ④: 画角は固定なので、ピンチは写真+3Dビューのズーム（中点基準）。
          const pts = [...pointers.values()];
          stageZoomAt(d / pinchDist, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        }
        pinchDist = d;
      } else if ((appModeRef.current === "ar" || appModeRef.current === "live") && arStepRef.current === "align" && arEditModeRef.current === "move") {
        // AR/ライブ④の「動かす」モード: 1本指ドラッグ＝写真+3Dビューをパン。
        stagePanBy(dx, dy);
      } else {
        // 1本指＝向き合わせ（ズーム(小fov)ほど感度を下げる）。実際の縦画角(camera.fov)基準。
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
      if (appModeRef.current !== "ar" && appModeRef.current !== "live") {
        cam.fov = THREE.MathUtils.clamp(cam.fov + Math.sign(e.deltaY) * 3, CAM_FOV_MIN, CAM_FOV_MAX);
        setCamFov(cam.fov);
        return;
      }
      // AR/ライブ④: 画角は固定なので、ホイールは写真+3Dビューのズーム（カーソル基準）。
      if (arStepRef.current === "align") {
        const rect = renderer.domElement.getBoundingClientRect();
        stageZoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
      }
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
      // AR向き決めフェーズ: タップした方向に撮影方向を向ける。
      if (arStepRef.current === "params") {
        if (appModeRef.current === "live") setLiveFollow(false); // 手動タップ=方位センサ追従を止めて固定
        aimAtScreen(e.clientX, e.clientY);
        return;
      }
      // カメラ視点（一人称）では山頂の選択/非選択を切り替えない（非表示のグレー山も拾わせない）。
      // 選択は地図（山選択フェーズ／シミュレーションの俯瞰）でのみ行う。
      if (cameraMode) return;
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

    // --- AR向き決めフェーズ: 地図を「タップ」した方向に撮影方向を向ける（撮影地点→タップ点の方位）。
    // ドラッグはパン/回転に使うため、方向指定はタップ（移動なし）で行う。
    const aimAtScreen = (clientX: number, clientY: number) => {
      const eye = arPinXZRef.current;
      if (!eye) return;
      const rect = renderer.domElement.getBoundingClientRect();
      tapNDC.set(
        ((clientX - rect.left) / mount.clientWidth) * 2 - 1,
        -((clientY - rect.top) / mount.clientHeight) * 2 + 1,
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

    // --- フライト（flyGoal）の補間。指定地点/2D3D切替などを滑らかに移動。 --- //
    const applyNav = () => {
      if (!flyGoal) return;
      camera.position.lerp(flyGoal.pos, 0.12);
      controls.target.lerp(flyGoal.target, 0.12);
      if (
        camera.position.distanceTo(flyGoal.pos) < 0.5 &&
        controls.target.distanceTo(flyGoal.target) < 0.5
      ) {
        camera.position.copy(flyGoal.pos);
        controls.target.copy(flyGoal.target);
        flyGoal = null;
        if (pending2DLock) {
          controls.maxPolarAngle = 0.0001; // 2D飛行が終わってから真上に固定
          pending2DLock = false;
        }
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
        // ロール（水平の傾き補正）は最後にビュー軸(ローカルZ)まわりで回す＝向きは変えずに傾けるだけ。
        if (cam.roll) camera.rotateZ(THREE.MathUtils.degToRad(cam.roll));
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
        // 写真／ライブ映像オーバーレイDOMを枠にぴったり合わせる（3D描画と同じ矩形）。
        if (arStage && stageRect) {
          const overlay = arPhotoElRef.current ?? liveVideoRef.current;
          if (overlay) {
            const s = overlay.style;
            s.left = `${stageRect.x}px`;
            s.top = `${stageRect.y}px`;
            s.width = `${stageRect.w}px`;
            s.height = `${stageRect.h}px`;
          }
          // ⑤出力(仕上げ)の編集ステージも同じ枠に合わせる（微調整と表示を一致）。
          if (arStepRef.current === "export" && arEditStageRef.current) {
            const s = arEditStageRef.current.style;
            s.left = `${stageRect.x}px`;
            s.top = `${stageRect.y}px`;
            s.width = `${stageRect.w}px`;
            s.height = `${stageRect.h}px`;
          }
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

      // AR撮影地点ピン（地点/向き決め/山選択の各フェーズで表示）。置いた地点を地表に追従表示。
      const arPinEl = arPinElRef.current;
      if (arPinEl) {
        const pxz = arPinXZRef.current;
        const st = arStepRef.current;
        if ((st === "locate" || st === "params" || st === "select") && pxz) {
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
      // 画面サイズが変わった時だけパネル予約高さを測り直す（折りたたみでは更新しない）。
      if (arHudRef.current) arPanelReserveRef.current = arHudRef.current.offsetHeight;
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
      ro.disconnect();
      apiRef.current = null;
      previewRing.geometry.dispose();
      (previewRing.material as THREE.Material).dispose();
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
    // mapVex/showPeaks はマウント時の初期値のみ使う（モード中は変化しない）。意図的に空依存。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存範囲のプレビュー円: オフライン保存モードで中心を設定している間だけ表示。
  useEffect(() => {
    apiRef.current?.setPreview(isOffline ? center : null, radiusKm);
  }, [center, radiusKm, isOffline]);

  // オフライン保存モードに入ったら保存済み容量を取得し直す。
  useEffect(() => {
    if (isOffline) navigator.storage?.estimate?.().then((e) => setStorageUsage(e.usage ?? 0));
  }, [isOffline]);

  // 微調整(④)・書き出し(⑤)に入った時に写真枠が予約するパネル高さを確定する。
  // 以後はセクションの折りたたみやパネル移動では測り直さないので、写真がそれに追従しない。
  useLayoutEffect(() => {
    if (arStep !== "align" && arStep !== "export") return;
    const measure = () => {
      if (arHudRef.current) arPanelReserveRef.current = arHudRef.current.offsetHeight;
    };
    measure();
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [arStep]);

  // ベースマップ切替を地形へ反映する。
  useEffect(() => {
    apiRef.current?.setBasemap(basemapById(basemapId));
  }, [basemapId]);


  // 空グラデーション表示の切替（ループから参照する ref に同期）。
  useEffect(() => {
    showSkyRef.current = showSky;
  }, [showSky]);

  // 写真ARの仕上げで使う山の解説(Wikipedia)を先読みしておく（出力遷移をもたつかせない）。
  useEffect(() => {
    if (appMode === "ar") void loadMountainDescriptions();
  }, [appMode]);

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
  // 操作モードをループ用 ref に同期。
  useEffect(() => {
    arEditModeRef.current = arEditMode;
  }, [arEditMode]);
  // フェーズが変わったら下部パネルは開いて中央へ戻し、写真ビュー(ズーム/パン)と操作モードも初期化。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArPanelOpen(true);
    setArDockOffset({ x: 0, y: 0 });
    setArEditMode("aim");
    apiRef.current?.resetStageView();
  }, [arStep]);
  // arLoc/方位を ref に同期（2D/3D切替の中心・背後角に使う。toggle effectを方位変化で再発火させない）。
  useEffect(() => {
    arLocRef.current = arLoc;
  }, [arLoc]);
  useEffect(() => {
    arHeadingRef.current = arHeadingDeg;
  }, [arHeadingDeg]);
  // 地図の2D/3D切替を反映。AR/ライブの向き決め(②)・山選択(③)では撮影地点中心に寄せ直す
  // （フェーズ間の専用フライトは廃し、この切替フライトが兼ねる）。それ以外は今の中心のまま傾けを変える。
  useEffect(() => {
    map2DRef.current = map2D;
    const dim = map2D ? "2d" : "3d";
    const st = arStepRef.current;
    if (arLocRef.current && (st === "params" || st === "select")) {
      apiRef.current?.setMapDimension(dim, arLocRef.current, arHeadingRef.current ?? 0);
    } else {
      apiRef.current?.setMapDimension(dim);
    }
  }, [map2D]);
  useEffect(() => {
    appModeRef.current = appMode;
  }, [appMode]);

  // 図鑑などから渡された初期地点へ、入場時に一度だけフライトする。
  // 2D/3D初期化([map2D] effect)が現在中心で flyGoal を設定するため、
  // それより「後」に定義してフライト先を上書きする（マウント時の effect は定義順に実行）。
  useEffect(() => {
    if (initialTarget) apiRef.current?.flyTo(initialTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    };
    img.src = photoUrl;
  }, [photoUrl]);

  // 向き決め(②)・山選択(③)の俯瞰中、視野コーンを地図に描画（写る方向の山を選びやすく）。
  // 地形シェーダのデカール（uniform書き換えのみ）なので2D/3D共通・即時・軽量。
  useEffect(() => {
    if (arLike && (arStep === "params" || arStep === "select") && arLoc) {
      apiRef.current?.setViewCone(arLoc.lon, arLoc.lat, arHeadingDeg ?? 0, arFovDeg);
    } else {
      apiRef.current?.hideViewCone();
    }
  }, [arLike, arStep, arLoc, arHeadingDeg, arFovDeg]);

  // スタンプ対象の山ID（arLabels の中身の変動＝ラベルドラッグで参照が変わっても、id
  // 自体が変わらないかぎり再生成は不要）。
  const stampMountainId = arLabels[captionIdx]?.id;
  // 3Dミニマップ・スタンプのプレビュー生成。仕上げ画面でオン時のみ。
  // 設定変更を 220ms デバウンスして再生成（DEM タイルは Cache 経由なので2回目以降は高速）。
  useEffect(() => {
    if (!stampOn || arStep !== "export" || !arLoc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStampPreview(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await renderTerrainStamp({
          center: { lat: arLoc.lat, lon: arLoc.lon },
          mountainId: stampMountainId,
          rangeKm: stampRangeKm,
          style: stampStyle,
          accent: stampAccent,
          headingDeg: arHeadingDeg,
          orientationMode: stampOrient,
          size: 384,
        });
        if (cancelled) return;
        setStampPreview({
          url: r.canvas.toDataURL("image/png"),
          mountain: r.mountain,
          oriented: r.oriented,
        });
      } catch {
        if (!cancelled) setStampPreview(null);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [
    stampOn,
    arStep,
    arLoc,
    arHeadingDeg,
    stampMountainId,
    stampRangeKm,
    stampStyle,
    stampAccent,
    stampOrient,
  ]);

  // 初回起動: 現在地が取れればそこへ移動し、ホームの基準にする。取れなければ日本全体ビューのまま。
  // ライブARは別途 startLiveLocate で現在地→撮影地点に置くのでここはスキップ。
  useEffect(() => {
    if (appMode === "live") return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        homeLocRef.current = loc;
        // 図鑑からの初期地点指定があるときは、現在地で上書きフライトしない（基準位置だけ保持）。
        if (!initialTarget) apiRef.current?.flyTo(loc);
      },
      () => undefined, // 失敗・拒否時は既定ビューのまま
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }, [appMode]);

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

  // celestialモード入場時に観測点を初期化（null のままだと skyInfo が出ず起動できないため）。
  useEffect(() => {
    if (!showCelestial) return;
    setSunObserver((prev) => prev ?? apiRef.current?.getCenter() ?? null);
  }, [showCelestial]);

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

  // 地図↔風景や AR③↔④ の「地図↔一人称」切替を暗転でつなぐ。暗転しきってから実際の切替
  // （カメラ移動＋地形再生成）を行い、地形が整うまで黒を保持してから明転する。暴れる瞬間が
  // 見えない。暗転中は切替先カードを出すので、長めの暗転でも「読み込み中」として自然。
  const switchViewWithFade = (
    info: { kind: "view"; icon: React.ReactNode; name: string } | { kind: "phase"; step: number; name: string },
    doSwitch: () => void,
  ) => {
    if (fadeBusyRef.current) return;
    fadeBusyRef.current = true;
    setFadeInfo(info);
    setViewFade(1); // 暗転（CSSトランジションで 0→1、350ms）
    window.setTimeout(() => {
      doSwitch(); // 暗転中に切替（カメラの飛び・地形リビルドを隠す）
      window.setTimeout(() => {
        setViewFade(0); // 明転（1→0、350ms）
        fadeBusyRef.current = false;
        window.setTimeout(() => setFadeInfo(null), 380); // 明転後に片付け
      }, 1300); // リビルド＆LODが落ち着くまで黒を保持（合計≒2秒）
    }, 350); // 暗転しきるまで
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
  // === ライブAR（カメラでその場AR）専用ヘルパ ===
  // 現在地(GPS)を取得して撮影地点に置く。取れなければメッセージ（地図タップでも指定可）。
  const startLiveLocate = () => {
    if (!navigator.geolocation) {
      setLiveStatus("この端末では現在地を取得できません。地図をタップして指定してください");
      return;
    }
    setLiveStatus("現在地を取得中…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLiveStatus(null);
        const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        homeLocRef.current = loc;
        placeArPoint(loc.lat, loc.lon);
        apiRef.current?.flyTo(loc);
      },
      (err) => {
        setLiveStatus(
          err.code === err.PERMISSION_DENIED
            ? "位置情報が許可されていません。地図をタップして指定してください"
            : "現在地を取得できませんでした。地図をタップして指定してください",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };
  // 背面カメラを開始して video に流す（微調整=ライブAR の背景）。
  const startLiveCamera = async () => {
    try {
      stopStream(liveStreamRef.current);
      const stream = await startRearCamera();
      liveStreamRef.current = stream;
      const v = liveVideoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => {});
      }
    } catch (e) {
      setLiveStatus(e instanceof Error ? e.message : "カメラを開始できませんでした");
    }
  };
  const stopLiveCamera = () => {
    stopStream(liveStreamRef.current);
    liveStreamRef.current = null;
    const v = liveVideoRef.current;
    if (v) v.srcObject = null;
  };
  // ライブのやり直し: 地点(GPS)からやり直す。
  const restartLive = () => {
    if (mode === "camera") exitCameraMode();
    stopLiveCamera();
    apiRef.current?.setControlMode("map");
    setArHeadingDeg(null);
    setArFovDeg(CAM_FOV_DEFAULT);
    changeCamRoll(0);
    setLiveFollow(true);
    setArStep("locate");
    startLiveLocate();
  };
  // ライブAR起動: マウント時に現在地(GPS)を取得して地点フェーズへ。終了時にカメラ/センサ解放。
  useEffect(() => {
    // 起動直後に一度だけGPS取得を開始（ステータス文言の setState を含むため明示的に許可）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (appMode === "live") startLiveLocate();
    return () => {
      stopLiveCamera();
      liveOriUnsubRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ライブAR 向き決め(②): 端末の方位センサで撮影方向を追従（スマホを水平にして向ける）。
  // liveFollow=OFF（固定）の間は購読しない＝コンパスが暴れず、手動の向きを保てる。
  useEffect(() => {
    if (appMode !== "live" || arStep !== "params" || !liveFollow) return;
    const unsub = subscribeOrientation((r) => {
      if (r.headingDeg == null) return;
      setLiveCompassDeg(r.headingDeg);
      setArHeadingDeg((prev) => {
        if (prev == null) return r.headingDeg;
        const diff = ((r.headingDeg! - prev + 540) % 360) - 180; // -180..180
        return Math.abs(diff) < 0.8 ? prev : r.headingDeg; // 微小変化は無視（再描画抑制）
      });
    });
    liveOriUnsubRef.current = unsub;
    return () => {
      unsub();
      liveOriUnsubRef.current = null;
    };
  }, [appMode, arStep, liveFollow]);
  // 「合わせる」フェーズへ: 撮影地点に着地し、向き・画角を初期化。
  const goAlign = (loc: { lat: number; lon: number }, headingDeg: number | null, fovDeg: number) => {
    setArStep("align");
    enterCameraMode({ lon: loc.lon, lat: loc.lat, headingDeg: headingDeg ?? undefined, fovDeg });
    if (appMode === "live") startLiveCamera(); // ライブARは背面カメラを背景に
  };
  // 写真を選んだら EXIF を読み、揃っていれば一気に、欠けていれば必要なフェーズへ進む。
  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルを連続で選べるようリセット
    if (!file) return;
    // ファイル選択（拡張子指定）から画像以外を選んだ場合は弾く。
    if (file.type && !file.type.startsWith("image/")) {
      alert("画像ファイルを選んでください（JPEG / PNG など）。");
      return;
    }
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
      setArPhotoLoc({ lat: exif.lat, lon: exif.lon }); // 後で「写真の位置に戻す」で復帰できるよう保持
      placeArPoint(exif.lat, exif.lon);
      apiRef.current?.flyTo({ lat: exif.lat, lon: exif.lon });
    } else {
      setArPhotoLoc(null); // 位置情報なしの写真
    }
    setArStep("locate"); // 位置の確認/指定フェーズへ（EXIFありは確認、なしは指定）
  };
  // AR/ライブ②③: 現在の2D/3D状態のまま、撮影地点中心に地図を寄せ直す。
  // フェーズ間の専用フライト（真上↔背後）は廃止し、2D/3D切替フライトと同じ枠組みに統一。
  // 2D=真上、3D=heading の背後上空から見下ろす。
  const frameArMapView = (headingDeg: number) => {
    if (!arLoc) return;
    apiRef.current?.setMapDimension(map2D ? "2d" : "3d", { lon: arLoc.lon, lat: arLoc.lat }, headingDeg);
  };
  // 撮影地点フェーズの「ここで決定」: 向きと画角をざっくり決めるフェーズへ（常に）。
  const confirmArLocate = () => {
    if (!arLoc) return;
    if (appMode === "live") {
      requestOrientationPermission(); // iOS等の方位センサ許可（ユーザー操作起点）
      setLiveFollow(true); // ②に入る時は方位センサ追従ONから（その後タップ/ボタンで固定）
    }
    frameArMapView(arHeadingDeg ?? 0); // 現在の2D/3Dで撮影地点中心へ寄せる
    apiRef.current?.setControlMode("map"); // パン/回転/ズーム可。方向はタップで指定
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
    if (appMode === "live") setLiveFollow(true); // ②へ戻る時は追従ONから
    frameArMapView(arHeadingDeg ?? 0);
    apiRef.current?.setControlMode("map");
    setArStep("params");
  };
  // 撮影地点を写真のGPS位置に戻す（手動でずらした地点を、写真EXIFの位置へ復帰）。
  const resetToPhotoLoc = () => {
    if (!arPhotoLoc) return;
    placeArPoint(arPhotoLoc.lat, arPhotoLoc.lon);
    apiRef.current?.flyTo({ lat: arPhotoLoc.lat, lon: arPhotoLoc.lon });
  };
  // 撮影地点に戻る（自由に見て回った後、フェーズ1で決めた地点へ視点を戻す）。
  const recenterAr = () => {
    if (!arLoc) return;
    if (arStep === "params" || arStep === "select") frameArMapView(arHeadingDeg ?? 0);
    else apiRef.current?.flyTo({ lat: arLoc.lat, lon: arLoc.lon }); // locate
  };
  // 向き・画角(②)→ 山選択(③)。撮影地点中心の俯瞰で、写る方向の山を奥行きつきで選ぶ。
  const goSelectFromParams = () => {
    if (!arLoc) return;
    frameArMapView(arHeadingDeg ?? 0); // 2D同士なら見た目そのまま（②③間の専用フライトは無し）
    apiRef.current?.setControlMode("map"); // パン/回転/ズーム可（シミュレーションと同じ操作）
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
    if (appMode === "live") stopLiveCamera(); // ライブは一旦カメラ停止（再入で再開）
    exitCameraMode(); // 一人称→地図
    frameArMapView(camHeading); // 微調整した向きを背後角に反映して③へ
    apiRef.current?.setControlMode("map");
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
    // フレーム: 切り抜き(crop)→余白(margin)→ふち(fade)。出力枠 OW×OH を作る。既定では従来と同一。
    const cl = cropInset.l * W, ct = cropInset.t * H;
    const cw = Math.max(1, W * (1 - cropInset.l - cropInset.r));
    const ch = Math.max(1, H * (1 - cropInset.t - cropInset.b));
    const cwR = Math.round(cw), chR = Math.round(ch);
    const mT = Math.round(frameMargin.t * chR), mB = Math.round(frameMargin.b * chR);
    const mL = Math.round(frameMargin.l * cwR), mR = Math.round(frameMargin.r * cwR);
    const OW = cwR + mL + mR, OH = chR + mT + mB; // 出力枠（ラベル位置・文字サイズの基準）
    // 写真正規化座標 → 出力枠ピクセル。点・ラベル・解説は写真にアンカーされているので、
    // 描いた写真の矩形(mL..mL+cwR, mT..mT+chR)に合わせて配置し、クロップ/余白に追従させる。
    const pfx = (pu: number) => mL + ((pu - cropInset.l) / fCwF) * cwR;
    const pfy = (pv: number) => mT + ((pv - cropInset.t) / fChF) * chR;
    const L = Math.max(OW, OH); // 文字サイズは出力枠の長辺基準（プレビューの cqmax と一致）
    const canvas = document.createElement("canvas");
    canvas.width = OW;
    canvas.height = OH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    if (mT || mB || mL || mR) {
      ctx.fillStyle = frameMarginColor;
      ctx.fillRect(0, 0, OW, OH);
    }
    ctx.drawImage(img, cl, ct, cw, ch, mL, mT, cwR, chR);
    // ふち: 余白のある辺で、写真を余白色へぼかす（写真側へ frameFade ぶん）。
    if (frameFade > 0 && (mT || mB || mL || mR)) {
      const fh = Math.round(frameFade * chR), fw = Math.round(frameFade * cwR);
      const rgba = (a: number) => `rgba(${hexToRgb(frameMarginColor)},${a})`;
      const fade = (x0: number, y0: number, x1: number, y1: number, x: number, y: number, w: number, h: number) => {
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        // S字イージング（smoothstep）。線形の折れ目をなくし、余白側の境界の浮きを消す。
        for (const { t, a } of FADE_STOPS) g.addColorStop(t, rgba(a));
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
      };
      if (mT && fh > 0) fade(0, mT, 0, mT + fh, mL, mT, cwR, fh); // 上
      if (mB && fh > 0) fade(0, mT + chR, 0, mT + chR - fh, mL, mT + chR - fh, cwR, fh); // 下
      if (mL && fw > 0) fade(mL, 0, mL + fw, 0, mL, mT, fw, chR); // 左
      if (mR && fw > 0) fade(mL + cwR, 0, mL + cwR - fw, 0, mL + cwR - fw, mT, fw, chR); // 右
    }
    const nameFs = Math.round(L * 0.026 * labelNameScale); // 山名（1段目）
    const subFs = Math.round(L * 0.026 * 0.62 * labelSubScale); // Mt.ローマ字｜標高（2段目）
    // 役割ごとのフォントファミリ（欧文先・和文後の合成スタック）。
    const ffName = roleFontStack(roleFonts.labelName);
    const ffSub = roleFontStack(roleFonts.labelSub);
    const ffTitle = roleFontStack(roleFonts.captionTitle);
    const ffBody = roleFontStack(roleFonts.captionBody);
    // 背景パネルを描く（半透明＋ドロップシャドウ＋角丸＋うっすら枠線）。文字の下に敷く。
    const drawPanel = (x: number, y: number, w: number, h: number, r: number, textColor: string) => {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.26)";
      ctx.shadowBlur = Math.round(L * 0.012);
      ctx.shadowOffsetY = Math.round(L * 0.0045);
      ctx.fillStyle = panelFill(textColor);
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
      ctx.shadowColor = "transparent"; // 枠線には影を載せない
      ctx.lineWidth = Math.max(1, Math.round(L * 0.0009));
      ctx.strokeStyle = panelStroke(textColor);
      ctx.stroke();
      ctx.restore();
    };
    // canvas はフォント未ロードだと既定にフォールバックするため、使うフォントを先に読み込む。
    const fontLoads: Promise<unknown>[] = [];
    for (const [w, id] of [
      [700, roleFonts.labelName],
      [500, roleFonts.labelSub],
      [700, roleFonts.captionTitle],
      [400, roleFonts.captionBody],
    ] as [number, FontPairId][]) {
      const p = FONT_PAIRS[id];
      fontLoads.push(document.fonts.load(`${w} 16px "${p.jp}"`).catch(() => {}));
      fontLoads.push(document.fonts.load(`${w} 16px "${p.en}"`).catch(() => {}));
    }
    await Promise.all(fontLoads);
    ctx.textBaseline = "alphabetic";
    if (bakeLabels) {
      for (const lb of arLabels) {
        const dotX = pfx(lb.dotU);
        const dotY = pfy(lb.dotV);
        const cx = pfx(lb.labelU); // ラベルの基準（下端中央。写真にアンカー）
        const cy = pfy(lb.labelV);
        const { name, sub } = labelContent(lb);
        const subBaseline = cy;
        // 補足があれば1段目はその上、無ければ1段目を下端（cy）に置く。
        const nameBaseline = sub ? cy - Math.round(subFs * 1.35) : cy;
        // リード線（ラベルの選んだ辺 → 山頂）。文字色に合わせる。点(頂点)は出力しない。
        // ラベルの実寸（テキスト幅・高さ）から上下左右の辺の中点を求める。
        ctx.font = `700 ${nameFs}px ${ffName}`;
        const nameW = ctx.measureText(name).width;
        let subW = 0;
        if (sub) {
          ctx.font = `500 ${subFs}px ${ffSub}`;
          subW = ctx.measureText(sub).width;
        }
        const boxW = Math.max(nameW, subW);
        const boxTop = nameBaseline - nameFs;
        const boxBottom = cy; // 下端基準（プレビューの名札ボックス下端＝labelV に対応）
        const boxMidY = (boxTop + boxBottom) / 2;
        const anchor = lb.labelAnchor ?? "bottom";
        // プレビューの選択枠（横1.2cqmax / 縦0.8cqmax）に合わせて辺の外側へ。
        const padH = L * 0.012, padV = L * 0.008;
        const ax = anchor === "left" ? cx - boxW / 2 - padH : anchor === "right" ? cx + boxW / 2 + padH : cx;
        const ay = anchor === "top" ? boxTop - padV : anchor === "bottom" ? boxBottom + padV : boxMidY;
        const bx = dotX, by = dotY;
        ctx.strokeStyle = labelColor;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = Math.max(1, L * 0.0022);
        ctx.beginPath();
        ctx.moveTo(ax + (bx - ax) * 0.17, ay + (by - ay) * 0.17);
        ctx.lineTo(ax + (bx - ax) * 0.83, ay + (by - ay) * 0.83);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // 背景パネル（選択枠と同じ範囲。文字の下に敷く）。
        if (labelBg !== "none") {
          drawPanel(cx - boxW / 2 - padH, boxTop - padV, boxW + padH * 2, boxBottom - boxTop + padV * 2, Math.round(L * 0.011), labelColor);
        }
        // 文字（中央揃え・影は文字色の反対色で可読性確保。暗色文字の白影は控えめ）
        ctx.save();
        if (labelShadow) {
          ctx.shadowColor = contrastShadow(labelColor);
          ctx.shadowBlur = Math.round(L * 0.0035);
          ctx.shadowOffsetY = Math.max(1, Math.round(L * 0.001));
        }
        ctx.textAlign = "center";
        ctx.fillStyle = labelColor;
        ctx.font = `700 ${nameFs}px ${ffName}`;
        ctx.fillText(name, cx, nameBaseline);
        if (sub) {
          ctx.font = `500 ${subFs}px ${ffSub}`;
          ctx.fillText(sub, cx, subBaseline);
        }
        ctx.restore();
      }
    }

    // 解説（可動ブロック・背景なし・影付き）。captionLang に応じ 日本語/英語/両方 を出す。両方は2カラム。
    // 長さ（長め/短め）は captionLength で選ぶ。
    const cap = arLabels[captionIdx];
    const capJa = cap ? descJa(cap) : undefined;
    const capEn = cap ? descEn(cap) : undefined;
    if (captionLang !== "none" && cap && (capJa || capEn)) {
      const cols: { title: string; body: string; lang: "ja" | "en" }[] = [];
      if ((captionLang === "ja" || captionLang === "both") && capJa)
        cols.push({ title: cap.name, body: capJa, lang: "ja" }); // 標高はラベル側に出すので解説には入れない
      if ((captionLang === "en" || captionLang === "both") && capEn)
        cols.push({ title: cap.nameEn || cap.name, body: capEn, lang: "en" });
      if (cols.length) {
        const titleFs = Math.round(L * 0.026 * captionTitleScale); // 解説タイトル
        const bodyFs = Math.round(L * 0.02 * captionBodyScale); // 解説本文
        const titleLineH = Math.round(titleFs * 1.3);
        const lineH = Math.round(bodyFs * 1.5);
        const blockW = Math.round(OW * captionW);
        const colGap = Math.round(OW * 0.035);
        const vertical = captionLayout === "vertical" && cols.length > 1; // 縦=上下に積む
        // 横並びは captionSplit（左=日本語の割合）で各カラム幅を決める。縦並びは全幅。
        const colWidths = vertical
          ? cols.map(() => blockW)
          : cols.length > 1
            ? [Math.round((blockW - colGap) * captionSplit), blockW - colGap - Math.round((blockW - colGap) * captionSplit)]
            : [blockW];
        ctx.textAlign = "left";
        // 折り返し: 日本語(CJK)は1文字単位、英語はスペース区切りで単語を割らない。
        // 1単語がカラム幅を超える場合だけ、その単語を文字単位でフォールバック分割する。
        const isCjk = (ch: string) => /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(ch);
        const wrapBody = (text: string, w: number): string[] => {
          const lines: string[] = [];
          let cur = "";
          const place = (unit: string) => {
            if (!cur) {
              if (ctx.measureText(unit).width <= w) { cur = unit; return; }
              // 単独でも入りきらない長い単語は文字単位で割る
              let seg = "";
              for (const ch of unit) {
                if (seg && ctx.measureText(seg + ch).width > w) { lines.push(seg); seg = ch; }
                else seg += ch;
              }
              cur = seg;
              return;
            }
            if (ctx.measureText(cur + unit).width <= w) { cur += unit; return; }
            lines.push(cur.replace(/\s+$/, "")); // 行末スペースは落とす
            cur = "";
            place(unit);
          };
          let i = 0;
          while (i < text.length) {
            const ch = text[i];
            if (ch === "\n") { lines.push(cur.replace(/\s+$/, "")); cur = ""; i++; continue; }
            if (ch === " " || ch === "\t") { if (cur) cur += " "; i++; continue; } // 単語間スペース
            if (isCjk(ch)) { place(ch); i++; continue; } // CJKは1文字ずつ
            let j = i; // 連続する非空白・非CJK＝英単語などのまとまり
            while (j < text.length && text[j] !== " " && text[j] !== "\t" && text[j] !== "\n" && !isCjk(text[j])) j++;
            place(text.slice(i, j));
            i = j;
          }
          if (cur) lines.push(cur.replace(/\s+$/, ""));
          return lines;
        };
        const wrapped = cols.map((c, ci) => {
          ctx.font = `400 ${bodyFs}px ${ffBody}`;
          return { title: c.title, lines: wrapBody(c.body, colWidths[ci]) };
        });
        const both = cols.length > 1;
        // まとめ表示の従（英）サイズ。左右はスラッシュで繋ぐので差を小さめ(0.8)、上下は0.6。
        const titleFsSmall = Math.round(titleFs * (captionTitleMode === "groupH" ? 0.8 : 0.6));
        const lineHFor = (fs: number) => Math.round(fs * 1.3);
        // 共有見出し（both かつ each 以外）。fs で大小、sharedRow で左右並び。
        // each・単一言語は各カラムに自前の見出しを付ける。
        const sharedParts: { text: string; fs: number }[] = !both
          ? []
          : captionTitleMode === "ja"
            ? [{ text: cols[0].title, fs: titleFs }]
            : captionTitleMode === "en"
              ? [{ text: cols[1].title, fs: titleFs }]
              : captionTitleMode === "groupV" || captionTitleMode === "groupH"
                ? [{ text: cols[0].title, fs: titleFs }, { text: cols[1].title, fs: titleFsSmall }]
                : []; // each
        const sharedRow = captionTitleMode === "groupH" && both; // 左右並び
        const colHasTitle = !both || captionTitleMode === "each";
        const capGap = Math.round(bodyFs * 0.7); // タイトル↔タグ↔本文↔本文 で均等にする隙間
        const rowGap = capGap; // 縦並びの段間（タグ周りと均等）
        // --- タグ（ピル）。山名と本文の間に差し込む。空なら一切描かない（既存と同じ）。 ---
        const tagFs = Math.round(bodyFs * 0.82);
        const tagPadX = Math.round(tagFs * 0.5);
        const tagPillH = tagFs + Math.round(tagFs * 0.32) * 2;
        const tagPillGap = Math.round(tagFs * 0.38);
        const tagRadius = Math.round(tagPillH / 2);
        const tagFont = `600 ${tagFs}px ${ffBody}`;
        type PillRow = { t: string; w: number }[];
        const layoutPills = (chips: string[], maxW: number): PillRow[] => {
          ctx.font = tagFont;
          const rows: PillRow[] = [];
          let cur: PillRow = [];
          let curW = 0;
          for (const t of chips) {
            const w = Math.ceil(ctx.measureText(t).width) + tagPadX * 2;
            if (cur.length && curW + tagPillGap + w > maxW) { rows.push(cur); cur = []; curW = 0; }
            if (cur.length) curW += tagPillGap;
            cur.push({ t, w });
            curW += w;
          }
          if (cur.length) rows.push(cur);
          return rows;
        };
        const pillsH = (rows: PillRow[]) => (rows.length ? rows.length * tagPillH + (rows.length - 1) * tagPillGap : 0);
        const drawPills = (rows: PillRow[], x: number, top: number) => {
          if (!rows.length) return;
          ctx.save();
          ctx.shadowColor = "transparent";
          const { bg, fg } = pillColors();
          let yy = top;
          for (const row of rows) {
            let xx = x;
            for (const { t, w } of row) {
              ctx.fillStyle = bg;
              ctx.beginPath();
              ctx.roundRect(xx, yy, w, tagPillH, tagRadius);
              ctx.fill();
              ctx.fillStyle = fg;
              ctx.font = tagFont;
              ctx.textBaseline = "middle";
              ctx.fillText(t, xx + tagPadX, yy + tagPillH / 2);
              xx += w + tagPillGap;
            }
            yy += tagPillH + tagPillGap;
          }
          ctx.textBaseline = "alphabetic";
          ctx.restore();
        };
        // タグ言語: 英語本文のときだけ英語、両方・日本語は日本語。
        const tagLang: "ja" | "en" = captionLang === "en" ? "en" : "ja";
        // タグの差し込み位置:
        //  - 単一言語: 山名の下（カラム内）に表示。
        //  - 両方かつ共有見出しモード: 見出しの下に1回表示。
        //  - 両方かつ「本文ごと」(each): 各本文に見出しが付くのでタグは出さない。
        const colTagRows = cols.map((_c, ci) => (colHasTitle && !both ? layoutPills(capChips(cap, tagLang), colWidths[ci]) : []));
        const colTagH = colTagRows.map((rows) => (rows.length ? capGap + pillsH(rows) + capGap : 0));
        const sharedTagRows = sharedParts.length ? layoutPills(capChips(cap, tagLang), blockW) : [];
        // 各本文カラムの高さ（自前見出し＋タグを含む場合あり）。
        const colBodyH = wrapped.map((w, ci) => (colHasTitle ? titleLineH : 0) + colTagH[ci] + w.lines.length * lineH);
        // 共有見出しの高さ：左右並びは1行（大きい方）、上下並びは各行の合計。
        const sharedTitleH = sharedParts.length
          ? sharedRow
            ? lineHFor(Math.max(...sharedParts.map((p) => p.fs)))
            : sharedParts.reduce((a, p) => a + lineHFor(p.fs), 0)
          : 0;
        const sharedGap = Math.round(bodyFs * 1.0); // 共有見出し→本文の余白（タグ無しのとき）
        // 共有見出しの下〜本文の間。タグありは「見出し→(capGap)→タグ→(capGap)→本文」で均等に。
        const sharedBelow = !sharedParts.length ? 0 : sharedTagRows.length ? capGap + pillsH(sharedTagRows) + capGap : sharedGap;
        // 本文ブロックの高さ：縦は積み上げ＋段間、横は最も高いカラムに合わせる。
        const bodyBlockH =
          sharedTitleH +
          sharedBelow +
          (vertical ? colBodyH.reduce((a, b) => a + b, 0) + rowGap * (cols.length - 1) : Math.max(...colBodyH));
        const blockH = bodyBlockH;
        const bx = Math.min(Math.max(0, Math.round(pfx(captionPos.u))), Math.max(0, OW - blockW));
        const by = Math.min(Math.max(0, Math.round(pfy(captionPos.v))), Math.max(0, OH - blockH));
        // 背景パネル（本文ブロックの下に敷く）。
        if (captionBg !== "none") {
          const px = Math.round(L * 0.018), py = Math.round(L * 0.015);
          drawPanel(bx - px, by - py, blockW + px * 2, bodyBlockH + py * 2, Math.round(L * 0.016), captionColor);
        }
        // 影で可読性を確保。影は文字色の反対色（暗色文字の白影は控えめ）。
        ctx.save();
        if (captionShadow) {
          ctx.shadowColor = contrastShadow(captionColor, 0.85);
          ctx.shadowBlur = Math.round(L * 0.004);
          ctx.shadowOffsetY = Math.max(1, Math.round(L * 0.001));
        }
        // 本文カラム（colHasTitle のとき自前見出し＋タグ付き）を (cx, top) に描く。
        const drawCol = (ci: number, cx: number, top: number) => {
          const w = wrapped[ci];
          let ty = top;
          ctx.fillStyle = captionColor;
          if (colHasTitle) {
            ctx.font = `700 ${titleFs}px ${ffTitle}`;
            ctx.fillText(w.title, cx, ty + titleFs);
            ty += titleLineH;
          }
          if (colHasTitle && colTagRows[ci].length) {
            ty += capGap;
            drawPills(colTagRows[ci], cx, ty);
            ty += pillsH(colTagRows[ci]) + capGap;
          }
          ctx.fillStyle = captionColor;
          ctx.font = `400 ${bodyFs}px ${ffBody}`;
          for (const ln of w.lines) { ctx.fillText(ln, cx, ty + bodyFs); ty += lineH; }
        };
        let ty = by;
        // 共有見出し（全幅・上にまとめる）。左右並びはベースラインを大きい方に揃えて横に並べる。
        if (sharedParts.length) {
          ctx.fillStyle = captionColor;
          if (sharedRow) {
            // 左右並び：ベースラインを大きい方に揃え、間にスラッシュ区切りを入れて横に並べる。
            const baseFs = Math.max(...sharedParts.map((p) => p.fs));
            const baseline = ty + baseFs;
            const gap = Math.round(baseFs * 0.32);
            let cxp = bx;
            sharedParts.forEach((p, pi) => {
              if (pi > 0) {
                ctx.font = `700 ${baseFs}px ${ffTitle}`;
                cxp += gap;
                ctx.globalAlpha = 0.7; // スラッシュは少し控えめ（プレビューと一致）
                ctx.fillText("/", cxp, baseline);
                ctx.globalAlpha = 1;
                cxp += ctx.measureText("/").width + gap;
              }
              ctx.font = `700 ${p.fs}px ${ffTitle}`;
              ctx.fillText(p.text, cxp, baseline);
              cxp += ctx.measureText(p.text).width;
            });
            ty += lineHFor(baseFs);
          } else {
            for (const p of sharedParts) {
              ctx.font = `700 ${p.fs}px ${ffTitle}`;
              ctx.fillText(p.text, bx, ty + p.fs);
              ty += lineHFor(p.fs);
            }
          }
          // 共有見出しモードのタグ（見出しの下・本文の上に一度だけ）。隙間は capGap で均等に。
          if (sharedTagRows.length) {
            ty += capGap;
            drawPills(sharedTagRows, bx, ty);
            ty += pillsH(sharedTagRows) + capGap;
          } else {
            ty += sharedGap; // タグ無し: 見出しと本文の間の余白
          }
        }
        // 本文（縦＝積む / 横＝左右に並べる）
        if (vertical) {
          wrapped.forEach((_w, ci) => {
            if (ci > 0) ty += rowGap;
            drawCol(ci, bx, ty);
            ty += colBodyH[ci];
          });
        } else {
          const top = ty;
          wrapped.forEach((_w, ci) => {
            drawCol(ci, bx + (ci === 0 ? 0 : colWidths[0] + colGap), top);
          });
        }
        ctx.restore();
      }
    }
    // === 3Dミニマップ・スタンプの焼き込み。stampOn のときだけ、ラベル/解説の上に乗せる。 ===
    if (stampOn && arLoc) {
      const SHORT = Math.min(OW, OH);
      const stampPx = Math.round(SHORT * 0.30); // 短辺の30%
      const margin = Math.round(SHORT * 0.04);
      // 高解像度で再生成（プレビューより大きく）。DEMはCache越しなので2回目は速い。
      let result: Awaited<ReturnType<typeof renderTerrainStamp>> | null;
      try {
        result = await renderTerrainStamp({
          center: { lat: arLoc.lat, lon: arLoc.lon },
          mountainId: arLabels[captionIdx]?.id,
          rangeKm: stampRangeKm,
          style: stampStyle,
          accent: stampAccent,
          headingDeg: arHeadingDeg,
          orientationMode: stampOrient,
          size: Math.max(384, Math.min(1024, stampPx * 2)),
        });
      } catch {
        result = null;
      }
      if (result) {
        // 背景カード（半透明・細白枠・角丸・影）。マージンの内側にカードがすっぽり収まるように配置。
        const cardPad = Math.round(SHORT * 0.012);
        const cardR = Math.round(SHORT * 0.012);
        const infoH = stampShowInfo && result.mountain ? Math.round(SHORT * 0.07) : 0;
        const cardW = stampPx + cardPad * 2;
        const cardH = stampPx + cardPad * 2 + infoH;
        const cardX =
          stampCorner === "br" || stampCorner === "tr" ? OW - margin - cardW : margin;
        const cardY =
          stampCorner === "br" || stampCorner === "bl" ? OH - margin - cardH : margin;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.32)";
        ctx.shadowBlur = Math.round(SHORT * 0.018);
        ctx.shadowOffsetY = Math.round(SHORT * 0.006);
        ctx.fillStyle = "rgba(8,12,17,0.66)";
        ctx.beginPath();
        ctx.roundRect(cardX, cardY, cardW, cardH, cardR);
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.lineWidth = Math.max(1, Math.round(SHORT * 0.0014));
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.stroke();
        ctx.restore();
        // スタンプ画像。
        const sx = cardX + cardPad;
        const sy = cardY + cardPad;
        ctx.drawImage(result.canvas, sx, sy, stampPx, stampPx);
        // 情報ブロック。山が見つかれば 名/標高/座標、見つからなければ「撮影地点」+ 座標。
        if (stampShowInfo) {
          const ffName = roleFontStack(roleFonts.captionTitle);
          const ffMono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
          await Promise.all([
            document.fonts.load(`700 16px "${FONT_PAIRS[roleFonts.captionTitle].jp}"`).catch(() => {}),
            document.fonts.load(`400 16px "${FONT_PAIRS[roleFonts.captionBody].jp}"`).catch(() => {}),
          ]);
          const infoX = sx;
          let infoY = sy + stampPx + Math.round(infoH * 0.18);
          const nameFs = Math.round(SHORT * 0.022);
          const elevFs = Math.round(SHORT * 0.018);
          const coordFs = Math.round(SHORT * 0.014);
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          if (result.mountain) {
            ctx.fillStyle = "#f5f3ec";
            ctx.font = `700 ${nameFs}px ${ffName}`;
            ctx.fillText(result.mountain.name, infoX, infoY + nameFs);
            infoY += nameFs + Math.round(nameFs * 0.18);
            ctx.fillStyle = stampAccent;
            ctx.font = `500 ${elevFs}px ${ffMono}`;
            ctx.fillText(`${Math.round(result.mountain.elevationM)} m`, infoX, infoY + elevFs);
            infoY += elevFs + Math.round(elevFs * 0.18);
            ctx.fillStyle = "rgba(245,243,236,0.55)";
            ctx.font = `400 ${coordFs}px ${ffMono}`;
            ctx.fillText(
              formatLatLonShort(result.mountain.lat, result.mountain.lon),
              infoX,
              infoY + coordFs,
            );
          } else {
            ctx.fillStyle = "#f5f3ec";
            ctx.font = `700 ${nameFs}px ${ffName}`;
            ctx.fillText("撮影地点", infoX, infoY + nameFs);
            infoY += nameFs + Math.round(nameFs * 0.18);
            ctx.fillStyle = "rgba(245,243,236,0.55)";
            ctx.font = `400 ${coordFs}px ${ffMono}`;
            ctx.fillText(formatLatLonShort(arLoc.lat, arLoc.lon), infoX, infoY + coordFs);
          }
        }
        // 出典クレジット（小さく、スタンプと反対側の下部に）。
        const credFs = Math.round(SHORT * 0.012);
        const credText = "地図・標高データ：国土地理院タイル";
        ctx.save();
        ctx.font = `400 ${credFs}px ${roleFontStack(roleFonts.captionBody)}`;
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = "rgba(245,243,236,0.55)";
        if (stampCorner === "bl") {
          ctx.textAlign = "right";
          ctx.fillText(credText, OW - margin, OH - margin);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(credText, margin, OH - margin);
        }
        ctx.restore();
      }
    }
    return canvas.toDataURL("image/jpeg", 0.92);
  };
  // 微調整(④)→ 仕上げ(⑤)。選択山を写真フレーム内の正規化座標で取り、編集用に展開。
  // 解説(Wikipedia)を id で引き当て、下部キャプション・焼き込み用にラベルへ付与する。
  const goExport = async () => {
    const sel = apiRef.current?.getPeakSelection() ?? [];
    const inFrame = sel.filter((p) => p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1); // 写真枠内のみ
    const descMap = await loadMountainDescriptions();
    const prefMap = new Map((await loadAllMountains()).map((m) => [m.id, m.prefecture]));
    const labels: ArLabel[] = inFrame.map((p) => {
      const d = descMap.get(p.id);
      return {
        id: p.id,
        name: p.name,
        elevM: p.elevM,
        dotU: p.u,
        dotV: p.v,
        labelU: p.u,
        labelV: Math.max(0.06, p.v - 0.12), // 名札は点の少し上を初期位置に
        description: d?.description_ja_long,
        descriptionShort: d?.description_ja_short,
        descriptionEn: d?.description_en_long,
        descriptionEnShort: d?.description_en_short,
        nameEn: d?.title_en,
        prefecture: prefMap.get(p.id),
        tagsJa: d?.tags_ja,
        tagsEn: d?.tags_en,
        source: d?.url,
      };
    });
    // キャプションは解説のある山を既定で取り上げる（なければ先頭）。
    const firstWithDesc = labels.findIndex((l) => l.description);
    setCaptionIdx(firstWithDesc >= 0 ? firstWithDesc : 0);
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
  const onEditDown = (i: number, kind: "dot" | "label" | "labelAnchor") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // 名札/点のドラッグは写真パンを開始させない
    (e.target as Element).setPointerCapture?.(e.pointerId);
    arDragRef.current = { i, kind };
  };
  // 解説ブロックのドラッグ開始（ラベル同様、掴んだ位置とブロック左上のズレを記録）。
  const onCaptionDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const stage = arFrameRef.current;
    if (stage) {
      const r = stage.getBoundingClientRect();
      const pu = (e.clientX - r.left) / r.width;
      const pv = (e.clientY - r.top) / r.height;
      const cf = photoToFrame(captionPos.u, captionPos.v); // 保持は写真座標→フレームでズレを取る
      captionDragRef.current = { offU: pu - cf.u, offV: pv - cf.v };
    }
    arDragRef.current = { i: -1, kind: "caption" };
  };
  // 解説ブロックのリサイズ（4辺のハンドル）。右/左=幅、上/下=縦に伸ばすと幅が狭まる。文字サイズは固定。
  const onCapResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const cl = el.classList;
    const side: "l" | "r" | "t" | "b" = cl.contains("ar-cap-handle--l")
      ? "l"
      : cl.contains("ar-cap-handle--t")
        ? "t"
        : cl.contains("ar-cap-handle--b")
          ? "b"
          : "r";
    const r = arFrameRef.current?.getBoundingClientRect();
    const cf = photoToFrame(captionPos.u, captionPos.v); // フレーム座標で辺位置を扱う
    capResizeRef.current = {
      side,
      startW: captionW,
      startV: r ? (e.clientY - r.top) / r.height : 0,
      boxLeft: cf.u,
      boxRight: cf.u + captionW,
    };
    arDragRef.current = { i: -1, kind: "capResize" };
  };
  // 両方表示の日英区切り線のドラッグ。左=日本語の割合(captionSplit)を変える。
  const onCapSplitDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    arDragRef.current = { i: -1, kind: "capSplit" };
  };
  // 仕上げ画面: 写真の余白部分をドラッグ＝写真+3Dビューをパン（「画像」モードのみ）。
  const onStagePanDown = (e: React.PointerEvent) => {
    if (arExportMode !== "image") return; // 編集モードでは写真は固定（ラベル・解説の操作優先）
    if ((e.target as HTMLElement).closest(".ar-edit-label, .ar-edit-dot")) return;
    let px = e.clientX;
    let py = e.clientY;
    const move = (ev: PointerEvent) => {
      apiRef.current?.stagePanBy(ev.clientX - px, ev.clientY - py);
      px = ev.clientX;
      py = ev.clientY;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  // 仕上げ画面: ホイールで写真+3Dビューをズーム（「画像」モードのみ）。
  const onStageWheel = (e: React.WheelEvent) => {
    if (arExportMode !== "image") return;
    apiRef.current?.stageZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
  };
  const onEditMove = (e: React.PointerEvent) => {
    const d = arDragRef.current;
    const stage = arFrameRef.current;
    if (!d || !stage) return;
    const r = stage.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    if (d.kind === "caption") {
      const off = captionDragRef.current ?? { offU: 0, offV: 0 };
      // ブロック幅(captionW)ぶん、フレーム内に収める（クランプはフレーム座標）。
      const maxU = Math.max(0, 1 - captionW);
      const fU = Math.min(maxU, Math.max(0, u - off.offU));
      const fV = Math.min(0.82, Math.max(0, v - off.offV));
      setCaptionPos(frameToPhoto(fU, fV)); // 保持は写真座標（クロップ/余白に追従）
      return;
    }
    if (d.kind === "capResize") {
      const rz = capResizeRef.current;
      if (!rz) return;
      const MINW = 0.22;
      if (rz.side === "r") {
        setCaptionW(Math.min(1 - rz.boxLeft, Math.max(MINW, u - rz.boxLeft)));
      } else if (rz.side === "l") {
        const newLeft = Math.min(rz.boxRight - MINW, Math.max(0, u));
        setCaptionPos((p) => ({ ...p, u: frameToPhoto(newLeft, 0).u }));
        setCaptionW(rz.boxRight - newLeft);
      } else if (rz.side === "b") {
        // 下へ引く=縦に伸びる=幅が狭まる（行数増）。上端は固定。
        setCaptionW(Math.min(1 - rz.boxLeft, Math.max(MINW, rz.startW - (v - rz.startV) * 1.4)));
      } else {
        // top: 上端が指に追従しつつ、上へ引くほど幅が狭まる（縦に伸びる）。
        const newTop = Math.min(0.9, Math.max(0, v));
        setCaptionPos((p) => ({ ...p, v: frameToPhoto(0, newTop).v }));
        setCaptionW(Math.min(1 - rz.boxLeft, Math.max(MINW, rz.startW - (rz.startV - v) * 1.4)));
      }
      return;
    }
    if (d.kind === "capSplit") {
      // 日英の境界。左=日本語の割合（captionPos は写真座標→フレームで比較）。
      const cfu = photoToFrame(captionPos.u, captionPos.v).u;
      setCaptionSplit(Math.min(0.8, Math.max(0.2, (u - cfu) / Math.max(0.001, captionW))));
      return;
    }
    if (d.kind === "labelAnchor") {
      // 引き出し線の起点（ラベルの辺）を切り替える。指の位置がラベル中心から見て近い辺にスナップ。
      const lb = arLabels[d.i];
      const box = labelBoxes[d.i] ?? { w: 0, h: 0 };
      const c = photoToFrame(lb.labelU, lb.labelV); // フレーム座標でラベル中心を求める
      const cxn = c.u;
      const cyn = c.v - box.h / 2; // ラベル中心
      const dx = (u - cxn) / Math.max(1e-4, box.w / 2);
      const dy = (v - cyn) / Math.max(1e-4, box.h / 2);
      const side = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
      setArLabels((prev) => prev.map((l, idx) => (idx !== d.i ? l : { ...l, labelAnchor: side })));
      return;
    }
    const p = frameToPhoto(u, v); // ドラッグ＝フレーム座標 → 保持する写真座標
    setArLabels((prev) =>
      prev.map((lb, idx) =>
        idx !== d.i ? lb : d.kind === "dot" ? { ...lb, dotU: p.u, dotV: p.v } : { ...lb, labelU: p.u, labelV: p.v },
      ),
    );
  };
  const onEditUp = () => {
    arDragRef.current = null;
  };
  // 出力枠(フレーム)を、外枠(ステージ)内に「contain」で収める px サイズに設定。
  useLayoutEffect(() => {
    const stageEl = arEditStageRef.current,
      frame = arFrameRef.current;
    if (!stageEl || !frame) return;
    const sw = stageEl.clientWidth,
      sh = stageEl.clientHeight;
    if (!sw || !sh || !frameAR) return;
    let w = sw,
      h = sw / frameAR;
    if (h > sh) {
      h = sh;
      w = sh * frameAR;
    }
    frame.style.width = `${Math.round(w)}px`;
    frame.style.height = `${Math.round(h)}px`;
  }, [frameAR, measureTick, arStep, arExportMode]);
  // ラベル実寸を測って正規化で保持（引き出し線の辺アンカー計算に使う）。
  // 位置(labelU/V)ドラッグでは寸法は変わらないので、変化時のみ state を更新。
  useLayoutEffect(() => {
    const stage = arFrameRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // 選択枠の余白（cqmax = ステージ長辺の1%）を正規化で保持。
    const cq = Math.max(r.width, r.height) / 100;
    const pad = { h: (1.2 * cq) / r.width, v: (0.8 * cq) / r.height };
    setLabelFramePad((prev) => (Math.abs(prev.h - pad.h) < 1e-5 && Math.abs(prev.v - pad.v) < 1e-5 ? prev : pad));
    const next: Record<number, { w: number; h: number }> = {};
    stage.querySelectorAll<HTMLElement>(".ar-edit-label").forEach((el) => {
      const idx = Number(el.dataset.idx);
      if (Number.isNaN(idx)) return;
      const b = el.getBoundingClientRect();
      next[idx] = { w: b.width / r.width, h: b.height / r.height };
    });
    setLabelBoxes((prev) => {
      const ks = Object.keys(next);
      const same =
        ks.length === Object.keys(prev).length &&
        ks.every((k) => prev[+k] && Math.abs(prev[+k].w - next[+k].w) < 1e-4 && Math.abs(prev[+k].h - next[+k].h) < 1e-4);
      return same ? prev : next;
    });
  }, [arLabels, labelMode, labelNameScale, labelSubScale, roleFonts, bakeLabels, arStep, arExportMode, measureTick]);
  // ステージのサイズはレンダーループが命令的に設定する（React state ではない）ため、
  // マウント直後は寸法未確定で pad=0 のことがある。ResizeObserver でサイズ確定/変化時に再計測。
  useEffect(() => {
    const stage = arEditStageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setMeasureTick((t) => t + 1));
    ro.observe(stage);
    return () => ro.disconnect();
  }, [arStep, appMode]);
  const changeCamEyeHeight = (m: number) => {
    setCamEyeHeight(m);
    apiRef.current?.setCamEyeHeight(m);
  };
  // 横画角をスライダーで変更（スクロール/ピンチと同じ cam.fov を動かす）。1度単位で微調整。
  const changeCamFov = (deg: number) => {
    setCamFov(deg);
    apiRef.current?.setCamFov(deg);
  };
  // 水平の傾き（ロール）をスライダーで補正。向きは変えずビュー軸まわりに回すだけ。
  const changeCamRoll = (deg: number) => {
    setCamRoll(deg);
    apiRef.current?.setCamRoll(deg);
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
  // ホーム: 現在地が判明していればそこへ、なければ日本全体ビューへ。

  // --- 太陽・月操作 --- //
  const setSunNow = () => {
    const d = new Date();
    setDateStr(toDateInput(d));
    setMinutes(d.getHours() * 60 + d.getMinutes());
  };
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmtTime = (d: Date | null) => (d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "—");
  const hhmm = `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;

  const SEARCH_MODES: { id: SearchMode; label: string }[] = [
    { id: "mountain", label: "山名" },
    { id: "place", label: "土地名" },
    { id: "both", label: "全て" },
  ];

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  // AR下部パネル: つかんで移動。フェーズが変わったら開いて中央に戻す。
  // move/up は window で拾う（pointer capture や重なり=stacking context に左右されず確実に動く）。
  const onDockGripDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return; // ボタン操作は移動にしない
    const px = e.clientX;
    const py = e.clientY;
    const ox = arDockOffset.x;
    const oy = arDockOffset.y;
    // ドラッグ開始時のパネル上端（=グリップ）の画面Y。グリップが画面内に残るよう上下とも制限する。
    const panel = (e.currentTarget as HTMLElement).parentElement;
    const startTop = panel ? panel.getBoundingClientRect().top : 0;
    const TOP_MARGIN = 8; // 画面上端からの最小マージン（グリップは必ず見える）
    const minY = oy + (TOP_MARGIN - startTop); // これ以上 上へは動かせない
    const maxY = oy + (window.innerHeight - 60 - startTop); // これ以上 下へは動かせない（グリップ分は残す）
    const move = (ev: PointerEvent) => {
      const x = Math.max(-window.innerWidth / 2 + 60, Math.min(window.innerWidth / 2 - 60, ox + (ev.clientX - px)));
      const y = Math.max(minY, Math.min(maxY, oy + (ev.clientY - py)));
      setArDockOffset({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // 下アンカーのパネルが上へ伸びて画面外へはみ出したら、下げてグリップを画面内に戻す保険。
  // 収まる時は y=0（最下部の定位置）へ戻す。展開/タブ切替によるサイズ変化を ResizeObserver で検知。
  const dockElRef = useRef<HTMLDivElement | null>(null);
  const dockObsRef = useRef<ResizeObserver | null>(null);
  const keepDockOnScreen = useCallback(() => {
    const el = dockElRef.current;
    if (!el) return;
    const TOP_MARGIN = 8;
    setArDockOffset((o) => {
      const rect = el.getBoundingClientRect();
      const naturalTop = rect.top - o.y; // y=0 のときの上端
      const targetY = naturalTop < TOP_MARGIN ? TOP_MARGIN - naturalTop : 0;
      return Math.abs(targetY - o.y) < 0.5 ? o : { ...o, y: targetY };
    });
  }, []);
  // パネルのルートに付けるコールバック ref。サイズ変化を監視して上記を発火。
  const dockRef = useCallback(
    (el: HTMLDivElement | null) => {
      dockObsRef.current?.disconnect();
      dockElRef.current = el;
      if (el && typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => keepDockOnScreen());
        ro.observe(el);
        dockObsRef.current = ro;
      }
    },
    [keepDockOnScreen],
  );
  // cam-hud は写真枠の予約高さ計算で arHudRef も使うので、両方にセットする。
  const camHudRef = useCallback(
    (el: HTMLDivElement | null) => {
      arHudRef.current = el;
      dockRef(el);
    },
    [dockRef],
  );

  // AR/ライブの進行表示（1〜5）。ドック・カメラHUD・出力編集の各下部パネルで使い回す。
  const arStepsBar =
    arLike && arStep !== "upload" ? (
      <div className="ar-steps">
        {(appMode === "live"
          ? (["locate", "params", "select", "align"] as ArStep[])
          : (["locate", "params", "select", "align", "export"] as ArStep[])
        ).map((k, idx, arr) => {
          const cur = arr.indexOf(arStep);
          const cls = idx < cur ? "done" : idx === cur ? "active" : "todo";
          const label: Record<ArStep, string> = {
            upload: "",
            locate: "地点",
            params: "向き画角",
            align: appMode === "live" ? "確認" : "微調整",
            select: "山選択",
            export: "出力",
          };
          return (
            <span key={k} className={`ar-step is-${cls}`}>
              <b>{idx + 1}</b>
              <span className="ar-step-label">{label[k]}</span>
            </span>
          );
        })}
      </div>
    ) : null;

  // ④⑤共通: 写真+3Dビューのズーム（＋/−）。％表示。−は等倍で無効。
  const stageZoomControls = (
    <div className="stage-zoom">
      <button
        className="stage-zoom-btn"
        title="縮小"
        aria-label="縮小"
        disabled={photoZoom <= 1.001}
        onClick={() => apiRef.current?.stageZoom(1 / 1.25)}
      >
        <IconMinus size={16} />
      </button>
      <span className="stage-zoom-val">{Math.round(photoZoom * 100)}%</span>
      <button className="stage-zoom-btn" title="拡大" aria-label="拡大" onClick={() => apiRef.current?.stageZoom(1.25)}>
        <IconPlus size={16} />
      </button>
    </div>
  );
  // ④のみ: ドラッグの役割を切替（編集=向き合わせ / 画像=写真パン）。⑤と同じ呼び名に揃える。
  const editModeToggle = (
    <div className="edit-mode-toggle" role="group" aria-label="操作モード">
      <button
        className={`emt-btn${arEditMode === "aim" ? " is-on" : ""}`}
        title="編集（ドラッグで向きを合わせる）"
        onClick={() => setArEditMode("aim")}
      >
        <IconLocate size={15} />
        編集
      </button>
      <button
        className={`emt-btn${arEditMode === "move" ? " is-on" : ""}`}
        title="画像（ドラッグで写真を移動）"
        onClick={() => setArEditMode("move")}
      >
        <IconMove size={15} />
        画像
      </button>
    </div>
  );
  // 仕上げ(⑤)の操作対象トグル: 画像（パン/ズーム）か、ラベル・解説の編集か。
  const exportModeToggle = (
    <div className="edit-mode-toggle" role="group" aria-label="操作対象">
      <button
        className={`emt-btn${arExportMode === "edit" ? " is-on" : ""}`}
        title="編集（ラベル・解説をドラッグで配置）"
        onClick={() => setArExportMode("edit")}
      >
        <IconLocate size={15} />
        編集
      </button>
      <button
        className={`emt-btn${arExportMode === "image" ? " is-on" : ""}`}
        title="画像（ドラッグ/ホイールで写真を移動・拡大）"
        onClick={() => setArExportMode("image")}
      >
        <IconMove size={15} />
        画像
      </button>
    </div>
  );

  // 各ドックの操作行。状態を持つもの（地図/カメラ・2D/3D）は選択ボタン（セグメント）で現在値を明示。
  // 動作（現在地/撮影地点に戻る）と 自由視点トグルはアイコンボタン。出し分けは各自で gate。
  const dockControls = (
    <div className="dock-viewbar">
      {simView && (
        <div className="seg" role="group" aria-label="視点">
          <button
            className={mode === "map" ? "is-active" : ""}
            title="地図（俯瞰）"
            onClick={() =>
              mode === "camera" &&
              switchViewWithFade({ kind: "view", icon: <IconMap size={26} />, name: "地図" }, exitCameraMode)
            }
          >
            <IconMap size={14} /> 地図
          </button>
          <button
            className={mode === "camera" ? "is-active" : ""}
            title="風景（その場に立って見回す）"
            onClick={() =>
              mode === "map" &&
              switchViewWithFade({ kind: "view", icon: <IconLandscape size={26} />, name: "風景" }, () =>
                enterCameraMode(),
              )
            }
          >
            <IconLandscape size={14} /> 風景
          </button>
        </div>
      )}
      {mode === "map" && (
        <div className="seg" role="group" aria-label="地図の表示">
          <button className={!map2D ? "is-active" : ""} title="3D（傾けられる地形）" onClick={() => setMap2D(false)}>
            <IconCube size={14} /> 3D
          </button>
          <button className={map2D ? "is-active" : ""} title="2D（真上の地図）" onClick={() => setMap2D(true)}>
            <IconGrid size={14} /> 2D
          </button>
        </div>
      )}
      {showCelestial && mode === "map" && (
        <button
          className={`dock-btn${freeLook ? " is-active" : ""}`}
          title="自由視点：地図解像度・太陽・月を固定したまま視点だけ動かす"
          onClick={toggleFreeLook}
        >
          <IconEye size={15} /> 自由視点
        </button>
      )}
      {mode === "map" && (
        <button className="dock-btn" title="現在地へ移動" onClick={goToCurrentLocation} disabled={locating}>
          {locating ? <span className="spinner" aria-hidden="true" /> : <IconLocate size={15} />} 現在地
        </button>
      )}
      {arLike && arLoc && mode === "map" && (
        <button className="dock-btn" title={appMode === "live" ? "現在地に戻る" : "撮影地点に戻る"} onClick={recenterAr}>
          <IconPin size={15} /> {appMode === "live" ? "地点に戻る" : "撮影地点へ"}
        </button>
      )}
    </div>
  );

  // 検索（対象セレクト＋入力＋ボタンを1行に）。各下部ドックで使い回す。
  const searchPanel = (
    <div className="dock-search">
      <form className="search-bar" onSubmit={doSearch}>
        <span className="search-mode">
          {searchMode === "mountain" ? (
            <IconMountain size={14} />
          ) : searchMode === "place" ? (
            <IconPin size={14} />
          ) : (
            <IconAll size={14} />
          )}
          <select
            value={searchMode}
            onChange={(e) => changeMode(e.target.value as SearchMode)}
            aria-label="検索対象"
            title="検索対象（山名／土地名／全て）"
          >
            {SEARCH_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </span>
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
        <button type="submit" className="search-go" title="検索" aria-label="検索" disabled={searching}>
          {searching ? (
            <span className="spinner" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <line x1="15.5" y1="15.5" x2="21" y2="21" />
            </svg>
          )}
          <span>検索</span>
        </button>
      </form>
      {results.length > 0 && (
        <ul className="search-results">
          {results.map((r, i) => (
            <li key={`${r.kind},${r.lat},${r.lon},${i}`}>
              <button onClick={() => goToResult(r)}>
                <span className="res-ico">{r.kind === "mountain" ? <IconMountain size={15} /> : <IconPin size={15} />}</span>
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
  );
  // ベースマップ切替（航空写真／標準／淡色／陰影）。
  const basemapPanel = (
    <div className="seg seg--fill">
      {BASEMAPS.map((b) => (
        <button key={b.id} className={b.id === basemapId ? "is-active" : ""} onClick={() => setBasemapId(b.id)}>
          {b.label}
        </button>
      ))}
    </div>
  );
  // 太陽・月の操作（日時＋スカイ情報）。
  const celestialControls = (
    <>
      <div className="datetime-row">
        <input type="date" className="dt-date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
        <span className="dt-time">{hhmm}</span>
        <button className="dt-now" onClick={setSunNow}>
          現在
        </button>
      </div>
      <input type="range" className="dt-slider" min={0} max={1439} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
      {skyInfo && (
        <div className="sky-card">
          <div className="sky-row">
            <IconSun size={22} className="sky-ico sky-ico--sun" />
            <div className="sky-info">
              <div className="sky-name">太陽</div>
              <div className="sky-sub">
                方位 {compass(skyInfo.sun.azimuthDeg)} {skyInfo.sun.azimuthDeg.toFixed(0)}° ・ 高度 {skyInfo.sun.altitudeDeg.toFixed(0)}°
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
                方位 {compass(skyInfo.moon.azimuthDeg)} {skyInfo.moon.azimuthDeg.toFixed(0)}° ・ 高度 {skyInfo.moon.altitudeDeg.toFixed(0)}°
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
                  <IconMoonPhase fraction={(1 - Math.cos(2 * Math.PI * p)) / 2} waxing={p < 0.5} size={18} />
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
  );
  // オフライン保存の操作。
  const offlineControls = (
    <>
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
        <input type="range" min={RADIUS_MIN} max={RADIUS_MAX} value={radiusKm} disabled={downloading} onChange={(e) => setRadiusKm(Number(e.target.value))} />
      </label>
      <label className="save-field">
        <span>
          最大ズーム（詳細度）: z{maxZ}
          {maxZ > 14 ? "（標高は z14 まで）" : ""}
        </span>
        <input type="range" min={PREFETCH_Z_MIN} max={PREFETCH_Z_MAX} value={maxZ} disabled={downloading} onChange={(e) => setMaxZ(Number(e.target.value))} />
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
              {plan.truncated && <div className="save-warn">範囲が広すぎるため上限で打ち切りました。半径を小さくしてください。</div>}
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
          <button className="save-btn save-btn--danger" onClick={cancelDownload}>
            中止
          </button>
        ) : (
          <button className="save-btn save-btn--primary" onClick={startDownload} disabled={!plan || plan.jobs.length === 0}>
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
    </>
  );

  // カメラHUDのスライダー行（ラベル左＋値右、必要なら向きの補足）。
  const camSlider = (label: React.ReactNode, value: React.ReactNode, input: React.ReactNode) => (
    <label className="cam-eye">
      <span className="cam-eye-head">
        <span>{label}</span>
        <b>{value}</b>
      </span>
      {input}
    </label>
  );
  // モードのパネルタイトル（ホームのカード名と揃える）。地図ドック・カメラHUDで共用。
  // タイトル文言はホームのカード定義（CARDS）を単一ソースにして、ホームと在モードで必ず一致させる。
  const modeCardTitle = CARDS.find((c) => c.mode === appMode)?.title ?? "";
  const modeTitle = (
    <>
      {showCelestial ? <IconSun size={15} /> : isOffline ? <IconDownload size={15} /> : <IconMountain size={15} />} {modeCardTitle}
    </>
  );
  // モードのアナウンス（タイトル直下に出す短い案内）。
  const modeHint = showCelestial
    ? "地図で場所を、「太陽・月」で日時を合わせると、太陽と月の方角・高さ、満ち欠け、日の出・日の入りがわかります。「風景」に切り替えると、空のどこに見えるかを確かめられます。"
    : isOffline
      ? "保存したい範囲を画面中央に置き、「画面中央を中心地点にする」で中心を決めます。半径と詳細度を選び、「ダウンロード」でこの範囲を端末に保存します。"
      : "ドラッグで視点を動かし、検索で行きたい場所へ。「風景」に切り替えると、その地に立った目線で山並みを見渡せます。";
  // 操作行（地図/カメラ・3D/2D・現在地・撮影地点へ 等）。タブ「操作」の中身に使う。
  // 折りたたみ帯をやめ、タブで1項目だけ表示する。アナウンスはタイトルなし本文のみ。
  const announce = (text: React.ReactNode) => <p className="dock-announce">{text}</p>;
  // 折りたたみセクション（コモン/メイン/タグ など）。非制御の <details>（既定は畳む）。
  // React は変化のない open プロップを再適用しないので、スライダー操作の再描画でも開閉状態は保たれる。
  const arSec = (key: string, title: string, children: React.ReactNode) => (
    <details key={key} className="ar-sec">
      <summary>{title}</summary>
      {children}
    </details>
  );
  type DockTab = { id: string; label: React.ReactNode; content: React.ReactNode };
  // パネル内のセクションをタブ化（key ごとに選択を保持）。1項目だけのときはタブ列を出さない。
  const dockTabs = (key: string, tabs: (DockTab | false | null | undefined)[]) => {
    const list = tabs.filter(Boolean) as DockTab[];
    if (!list.length) return null;
    const active = list.some((t) => t.id === dockTab[key]) ? dockTab[key] : list[0].id;
    return (
      <div className="dock-tabwrap">
        {list.length > 1 && (
          <div className="dock-tabs" role="tablist">
            {list.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === active}
                className={`dock-tab${t.id === active ? " is-active" : ""}`}
                onClick={() => setDockTab((s) => ({ ...s, [key]: t.id }))}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="dock-tab-body">{list.find((t) => t.id === active)?.content}</div>
      </div>
    );
  };
  // 「操作」タブの中身（地図/カメラ・3D/2D・現在地 等）。
  const viewTab: DockTab = {
    id: "view",
    label: (
      <>
        <IconMove size={13} /> 操作
      </>
    ),
    content: dockControls,
  };
  // カメラ視点の読み取り・スライダー（地形/天体のカメラビューと AR で使い回す）。
  const cameraReadout = (
    <div className="cam-readout">
      <div className="cam-stat">
        <span>方位</span>
        <b>{compass(camHeading)} {Math.round(camHeading)}°</b>
      </div>
      <div className="cam-stat">
        <span>仰角</span>
        <b>{Math.round(camPitch)}°</b>
      </div>
      <div className="cam-stat">
        <span>横画角</span>
        <b>{Math.round(camFov)}°</b>
      </div>
    </div>
  );
  const eyeSlider = camSlider(
    "目線高さ",
    `${camEyeHeight} m`,
    <input type="range" min={-200} max={200} value={camEyeHeight} onChange={(e) => changeCamEyeHeight(Number(e.target.value))} />,
  );
  const fovSlider = camSlider(
    <>
      横画角 <i className="cam-eye-sub">望遠 ←→ 広角</i>
    </>,
    `${Math.round(camFov)}°`,
    <input type="range" min={CAM_FOV_MIN} max={CAM_FOV_MAX} value={Math.round(camFov)} onChange={(e) => changeCamFov(Number(e.target.value))} />,
  );
  const rollSlider = camSlider(
    <>
      水平の傾き <i className="cam-eye-sub">左 ←→ 右</i>
    </>,
    `${camRoll}°`,
    <input type="range" min={-45} max={45} step={0.5} value={camRoll} onChange={(e) => changeCamRoll(Number(e.target.value))} />,
  );

  return (
    <div className="mapview">
      <div className="mapview-canvas" ref={mountRef} />

      {/* 地図↔風景・AR③↔④ の切替を隠す暗転フェード（最前面）。種類で中身を変える。 */}
      <div className={`view-fade${viewFade ? " is-on" : ""}`} style={{ opacity: viewFade }} aria-hidden="true">
        {/* ビュー切替（地図/風景）: セグメント調の小チップ。モード開始の大カードと区別。 */}
        {fadeInfo?.kind === "view" && (
          <div className="fade-pill">
            <span className="fade-pill-ico">{fadeInfo.icon}</span>
            <span className="fade-pill-name">{fadeInfo.name}</span>
          </div>
        )}
        {/* AR フェーズ移動: ①〜⑤のステップバーで現在を強調＝ウィザード進行と分かる。 */}
        {fadeInfo?.kind === "phase" && (
          <div className="fade-steps">
            <div className="fade-steps-row">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={`fade-step${n === fadeInfo.step ? " is-current" : ""}`}>
                  {n}
                </span>
              ))}
            </div>
            <span className="fade-steps-name">{fadeInfo.name}</span>
          </div>
        )}
      </div>

      {/* 写真オーバーレイ（カメラ視点でのみ。位置・サイズはループが写真枠に合わせる） */}
      {mode === "camera" && appMode !== "live" && photoUrl && (
        <img
          ref={arPhotoElRef}
          className="photo-overlay"
          src={photoUrl}
          alt=""
          style={{ opacity: photoOpacity }}
        />
      )}

      {/* ライブAR: 背面カメラ映像オーバーレイ（微調整=ライブARの背景。枠はループが追従）。
          メタデータ読込でアスペクトを設定→3D枠が映像比に合う。 */}
      {appMode === "live" && mode === "camera" && (
        <video
          ref={liveVideoRef}
          className="photo-overlay"
          autoPlay
          playsInline
          muted
          style={{ opacity: photoOpacity, objectFit: "cover" }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) {
              const a = v.videoWidth / v.videoHeight;
              arPhotoAspectRef.current = a;
            }
          }}
        />
      )}

      {/* 写真取り込み input（モード非依存で1つだけ。地図/カメラ両方の入口から呼ぶ） */}
      {/* accept を付けない＝Android でフォトピッカー(画像専用・位置情報を削る)ではなく
          ファイル(ドキュメント)選択が開き、EXIF(GPS)が保たれる。画像以外は onPickPhoto で弾く。 */}
      <input ref={photoInputRef} type="file" hidden onChange={onPickPhoto} />

      {/* ① 写真選択フェーズ */}
      {appMode === "ar" && arStep === "upload" && (
        <div className="ar-intro">
          <span className="ar-intro-icon">
            <IconImage size={34} />
          </span>
          <h2>山を写す</h2>
          <p>
            撮った山の写真を選ぶと、その場所から見える山に名前を重ねられます。
            <br />
            位置情報（GPS）があれば自動で、なければ撮影地点を選びます。
          </p>
          <button className="ar-intro-pick" onClick={() => photoInputRef.current?.click()}>
            <IconImage size={16} />
            <span>写真を選ぶ</span>
          </button>
        </div>
      )}


      {/* 撮影地点ピン（AR地図フェーズ：地点/向き決め/山選択で表示。位置はループが追従）。
          先端をDEM表面に合わせて接地（sampleSurfaceY修正で浮かない）。 */}
      {arLike && mode === "map" && (
        <div ref={arPinElRef} className="ar-pin" style={{ display: "none" }}>
          <IconPin size={30} />
        </div>
      )}

      {/* AR下部ドック（地図フェーズ）: 進行表示＋アナウンス＋操作を1つのパネルに集約。
          つかんで移動・畳んで地図を見やすくできる。 */}
      {arLike && (arStep === "locate" || arStep === "params" || arStep === "select") && (
        <div
          className="ar-dock"
          ref={dockRef}
          style={{ transform: `translate(calc(-50% + ${arDockOffset.x}px), ${arDockOffset.y}px)` }}
        >
          <div
            className="ar-panel-grip"
            onPointerDown={onDockGripDown}
          >
            {arStepsBar}
            <button
              className="ar-panel-toggle"
              title={arPanelOpen ? "畳む" : "開く"}
              aria-label={arPanelOpen ? "畳む" : "開く"}
              onClick={() => setArPanelOpen((o) => !o)}
            >
              <IconCaret dir={arPanelOpen ? "down" : "up"} size={16} />
            </button>
          </div>
          {arPanelOpen && (
            <div className="ar-dock-body">
              {/* アナウンス（タイトル直下） */}
              {announce(
                arStep === "locate"
                  ? appMode === "live"
                    ? liveStatus ??
                      (arLoc
                        ? "現在地はここです。合っていますか？ ずれていれば地図をタップして直せます。"
                        : "現在地を取得しています…。地図をタップして指定することもできます。")
                    : arLoc
                      ? "写真を撮った場所はここでしょうか。ずれていれば、地図のタップか検索で直せます。"
                      : "写真を撮った場所を指定します。地図をタップ、または下の検索で選んでください。"
                  : arStep === "params"
                    ? appMode === "live"
                      ? liveFollow
                        ? `スマホを水平に保ち、写したい方角へ向けてください（方位センサで追従${
                            liveCompassDeg == null ? "／取得待ち…" : "中"
                          }）。地図のタップか下のボタンで、その向きに固定できます。`
                        : "向きを固定中です。地図をタップして微調整、下のボタンで方位センサ追従に戻せます。スライダーで画角を合わせます。"
                      : "写真が向いている方向を、地図のタップで指します。スライダーで画角（写る範囲の広さ）を合わせます。"
                    : `${appMode === "live" ? "見えている山" : "写真に写る山"}をタップして選びます。地図は自由に動かせ、ずれたら「${appMode === "live" ? "地点に戻る" : "撮影地点へ"}」で元の構図に戻せます。`,
              )}
              {/* セクションはタブで1つだけ表示 */}
              {dockTabs(`ar-${arStep}`, [
                arStep === "params"
                  ? {
                      id: "params",
                      label: <><IconCompass size={13} /> 向き・画角</>,
                      content: (
                        <>
                          <div className="cam-readout">
                            <div className="cam-stat">
                              <span>方向</span>
                              <b>{compass(arHeadingDeg ?? 0)} {Math.round(arHeadingDeg ?? 0)}°</b>
                            </div>
                            <div className="cam-stat">
                              <span>横画角</span>
                              <b>{Math.round(arFovDeg)}°</b>
                            </div>
                          </div>
                          {appMode === "live" && (
                            <button className={`ar-follow-toggle${liveFollow ? " is-on" : ""}`} onClick={() => setLiveFollow((v) => !v)}>
                              <IconLocate size={14} />
                              {liveFollow ? "方位センサーで追従中（タップで固定）" : "固定中（タップで方位センサーに戻す）"}
                            </button>
                          )}
                          {camSlider(
                            <>
                              画角 <i className="cam-eye-sub">望遠 ←→ 広角</i>
                            </>,
                            `${Math.round(arFovDeg)}°`,
                            <input type="range" min={CAM_FOV_MIN} max={CAM_FOV_MAX} value={Math.round(arFovDeg)} onChange={(e) => setArFovDeg(Number(e.target.value))} />,
                          )}
                        </>
                      ),
                    }
                  : null,
                // 検索（地点・山選択・向き画角）。フェーズ2は2番目に配置。
                arStep === "select" || arStep === "params" || (arStep === "locate" && appMode !== "live")
                  ? { id: "search", label: <><IconSearch size={13} /> 検索</>, content: searchPanel }
                  : null,
                // ARは「操作」を末尾に。
                viewTab,
              ])}
              {/* 進行ボタン（最下部） */}
              {arStep === "locate" && (
                <div className="ar-dock-actions">
                  {appMode === "live" ? (
                    <button className="ar-btn-sub" onClick={restartLive}>
                      現在地を取り直す
                    </button>
                  ) : (
                    <button
                      className="ar-btn-sub"
                      onClick={resetToPhotoLoc}
                      disabled={!arPhotoLoc}
                      title={arPhotoLoc ? "写真の位置情報(GPS)に撮影地点を戻す" : "この写真に位置情報がありません"}
                    >
                      写真の位置に戻す
                    </button>
                  )}
                  <button
                    className="ar-btn-main"
                    title="ここで決定（次へ）"
                    aria-label="ここで決定（次へ）"
                    disabled={!arLoc}
                    onClick={confirmArLocate}
                  >
                    次へ
                    <IconChevron dir="right" size={18} />
                  </button>
                </div>
              )}
              {arStep === "params" && (
                <div className="ar-dock-actions">
                  <button className="ar-btn-sub ar-btn--icon" title="撮影地点へ戻る" aria-label="撮影地点へ戻る" onClick={backToLocate}>
                    <IconChevron dir="left" size={18} />
                  </button>
                  <button className="ar-btn-main" title="山を選ぶ（次へ）" aria-label="山を選ぶ（次へ）" onClick={confirmArParams}>
                    次へ
                    <IconChevron dir="right" size={18} />
                  </button>
                </div>
              )}
              {arStep === "select" && (
                <div className="ar-dock-actions">
                  <button className="ar-btn-sub ar-btn--icon" title="向き・画角へ戻る" aria-label="向き・画角へ戻る" onClick={backToParams}>
                    <IconChevron dir="left" size={18} />
                  </button>
                  <span className="ar-select-count">選択 {peakSelCount} 山</span>
                  <button
                    className="ar-btn-main"
                    title={appMode === "live" ? "確認へ（次へ）" : "微調整へ（次へ）"}
                    aria-label={appMode === "live" ? "確認へ（次へ）" : "微調整へ（次へ）"}
                    onClick={() =>
                      switchViewWithFade({ kind: "phase", step: 4, name: "微調整" }, goAlignFromSelect)
                    }
                  >
                    次へ
                    <IconChevron dir="right" size={18} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ⑤ 出力(仕上げ): 写真に名札・点を重ね、ドラッグで微調整してからダウンロード。
          画像枠は微調整(④)と同じ arStageRect で配置（render loop が left/top/w/h を設定）。
          パネルは①〜④と同じ統一シェル（グリップ＝ステップ＋折り畳み、本体＝ヒント＋操作）。 */}
      {appMode === "ar" && arStep === "export" && (
        <div className="ar-edit">
          <div
            className={`ar-edit-stage${arExportMode === "image" ? " is-image-mode" : ""}`}
            ref={arEditStageRef}
            onPointerDown={onStagePanDown}
            onWheel={onStageWheel}
            style={
              {
                "--label-name-fs": labelNameScale, // ラベル1段目（山名）
                "--label-sub-fs": labelSubScale, // ラベル2段目（補足）
                "--cap-title-fs": captionTitleScale, // 解説タイトル
                "--cap-body-fs": captionBodyScale, // 解説本文
                "--label-name-ff": roleFontStack(roleFonts.labelName), // 山名フォント
                "--label-sub-ff": roleFontStack(roleFonts.labelSub), // 補足フォント
                "--cap-title-ff": roleFontStack(roleFonts.captionTitle), // タイトルフォント
                "--cap-body-ff": roleFontStack(roleFonts.captionBody), // 本文フォント
              } as React.CSSProperties
            }
          >
            {/* 出力枠（フレーム）。切り抜き・余白・ふちを反映。ラベル/解説はこの枠基準。 */}
            <div
              className="ar-frame"
              ref={arFrameRef}
              style={{ background: fAnyMargin ? frameMarginColor : "#000" }}
            >
              <div className="ar-frame-photo" style={framePhotoStyle}>
                {photoUrl && (
                  <img
                    className="ar-edit-photo"
                    src={photoUrl}
                    alt=""
                    draggable={false}
                    style={frameCropImgStyle}
                    onLoad={(e) => {
                      const im = e.currentTarget;
                      if (im.naturalWidth) setPhotoNat({ w: im.naturalWidth, h: im.naturalHeight });
                    }}
                  />
                )}
                {(["t", "b", "l", "r"] as const).map((d) => {
                  const s = fadeStyle(d);
                  return s ? <div key={d} style={s} /> : null;
                })}
              </div>
            {/* 山名ラベル（表示ONのときだけ。引き出し線＋点＋名札） */}
            {bakeLabels && (
              <>
                {/* 出力されるリード線（文字色・中心66%だけ実線、両端17%は余白）。焼き込みのプレビュー。 */}
                <svg className="ar-edit-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
                  {arLabels.map((lb, i) => {
                    const sp = labelSidePoint(i);
                    const dp = photoToFrame(lb.dotU, lb.dotV);
                    const ax = sp.x * 100, ay = sp.y * 100;
                    const bx = dp.u * 100, by = dp.v * 100;
                    return (
                      <line
                        key={i}
                        x1={ax + (bx - ax) * 0.17}
                        y1={ay + (by - ay) * 0.17}
                        x2={ax + (bx - ax) * 0.83}
                        y2={ay + (by - ay) * 0.83}
                        stroke={labelColor}
                        strokeOpacity={0.9}
                        strokeWidth={1.2}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  })}
                </svg>
                {/* 青の編集UI（ガイド線＋点）。各要素は不透明にし、この層に一度だけ不透明度を掛ける＝
                    同じ層内で重なっても合成は1回きりなので色が濃くならない。出力には焼き込まない。 */}
                <div className="ar-edit-chrome">
                  <svg className="ar-edit-guides" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {arLabels.map((lb, i) => {
                      const sp = labelSidePoint(i);
                      const dp = photoToFrame(lb.dotU, lb.dotV);
                      return (
                        <line
                          key={i}
                          x1={sp.x * 100}
                          y1={sp.y * 100}
                          x2={dp.u * 100}
                          y2={dp.v * 100}
                          stroke="rgb(214,180,106)"
                          strokeWidth={1.2}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}
                  </svg>
                  {arLabels.map((lb, i) => {
                    const sp = labelSidePoint(i);
                    const dp = photoToFrame(lb.dotU, lb.dotV);
                    return (
                      <div key={i}>
                        {/* 山頂側のアンカー点（ドラッグで山頂位置を調整） */}
                        <div
                          className="ar-edit-dot"
                          style={{ left: `${dp.u * 100}%`, top: `${dp.v * 100}%` }}
                          onPointerDown={onEditDown(i, "dot")}
                          onPointerMove={onEditMove}
                          onPointerUp={onEditUp}
                        />
                        {/* 引き出し線の起点（ドラッグで上下左右の辺に付け替え）。ラベル移動は名札本体をドラッグ。 */}
                        <div
                          className="ar-edit-dot ar-edit-anchor"
                          style={{ left: `${sp.x * 100}%`, top: `${sp.y * 100}%` }}
                          onPointerDown={onEditDown(i, "labelAnchor")}
                          onPointerMove={onEditMove}
                          onPointerUp={onEditUp}
                        />
                      </div>
                    );
                  })}
                </div>
                {/* ラベル本体（文字・全不透明）。内容は labelMode に従う。 */}
                {arLabels.map((lb, i) => {
                  const lc = labelContent(lb);
                  const lp = photoToFrame(lb.labelU, lb.labelV);
                  return (
                    <div
                      key={i}
                      className={`ar-edit-label${labelBg !== "none" ? " has-panel" : ""}`}
                      data-idx={i}
                      style={
                        {
                          left: `${lp.u * 100}%`,
                          top: `${lp.v * 100}%`,
                          color: labelColor,
                          "--label-sh": labelShadow ? contrastShadow(labelColor) : "transparent",
                          ...(labelBg !== "none"
                            ? {
                                "--label-panel-bg": panelFill(labelColor),
                                "--label-panel-bd": panelStroke(labelColor),
                              }
                            : {}),
                        } as React.CSSProperties
                      }
                      onPointerDown={onEditDown(i, "label")}
                      onPointerMove={onEditMove}
                      onPointerUp={onEditUp}
                    >
                      <span className="ar-label-name">{lc.name}</span>
                      {lc.sub && <span className="ar-label-sub">{lc.sub}</span>}
                    </div>
                  );
                })}
              </>
            )}
            {/* 解説（可動ブロック・背景なし）。言語モードで 日本語/英語/両方。両方は2カラム。 */}
            {captionLang !== "none" &&
              arLabels[captionIdx] &&
              (arLabels[captionIdx].description || arLabels[captionIdx].descriptionEn) && (
                <div
                  className={`ar-caption${captionBg !== "none" ? " has-panel" : ""}`}
                  style={
                    {
                      left: `${photoToFrame(captionPos.u, captionPos.v).u * 100}%`,
                      top: `${photoToFrame(captionPos.u, captionPos.v).v * 100}%`,
                      width: `${captionW * 100}%`,
                      color: captionColor,
                      "--cap-sh": captionShadow ? contrastShadow(captionColor, 0.85) : "transparent",
                      "--cap-tag-bg": pillColors().bg,
                      "--cap-tag-fg": pillColors().fg,
                      ...(captionBg !== "none"
                        ? {
                            "--cap-panel-bg": panelFill(captionColor),
                            "--cap-panel-bd": panelStroke(captionColor),
                          }
                        : {}),
                    } as React.CSSProperties
                  }
                  onPointerDown={onCaptionDown}
                  onPointerMove={onEditMove}
                  onPointerUp={onEditUp}
                >
                  {/* 共有見出し（両方かつ each 以外。上にまとめる。row=左右並び（スラッシュ区切り）・sub=小さめ） */}
                  {capSharedTitleParts.length > 0 && (
                    <div
                      className={`ar-cap-shared${capSharedRow ? " is-row" : ""}${capSharedHasTags ? " has-tags" : ""}`}
                      style={capSharedRow ? ({ "--cap-sub-ratio": 0.8 } as React.CSSProperties) : undefined}
                    >
                      {capSharedRow ? (
                        <>
                          <div className="ar-caption-title">{capName}</div>
                          <div className="ar-caption-title ar-cap-sep">/</div>
                          <div className="ar-caption-title is-sub">{capNameEn}</div>
                        </>
                      ) : (
                        capSharedTitleParts.map((p, i) => (
                          <div key={i} className={`ar-caption-title${p.sub ? " is-sub" : ""}`}>{p.text}</div>
                        ))
                      )}
                    </div>
                  )}
                  {/* 共有見出しモードのタグ（見出しの下・本文の上） */}
                  {capSharedTitleParts.length > 0 && capTagEls(capTagLang)}
                  <div className={`ar-cap-cols${capBoth && captionLayout === "vertical" ? " is-vertical" : ""}`}>
                    {(captionLang === "ja" || captionLang === "both") && arLabels[captionIdx].description && (
                      <div
                        className="ar-cap-col"
                        style={capBoth && captionLayout === "horizontal" ? { flex: `${captionSplit} 1 0` } : undefined}
                      >
                        {capColHasTitle && <div className="ar-caption-title">{arLabels[captionIdx].name}</div>}
                        {capColHasTitle && !capBoth && capTagEls(capTagLang)}
                        <p className="ar-caption-text">{descJa(arLabels[captionIdx])}</p>
                      </div>
                    )}
                    {capBoth && captionLayout === "horizontal" && (
                      <div
                        className="ar-cap-divider"
                        title="日英の境界を動かす"
                        onPointerDown={onCapSplitDown}
                        onPointerMove={onEditMove}
                        onPointerUp={onEditUp}
                      />
                    )}
                    {(captionLang === "en" || captionLang === "both") && arLabels[captionIdx].descriptionEn && (
                      <div
                        className="ar-cap-col"
                        style={capBoth && captionLayout === "horizontal" ? { flex: `${1 - captionSplit} 1 0` } : undefined}
                      >
                        {capColHasTitle && <div className="ar-caption-title">{arLabels[captionIdx].nameEn || arLabels[captionIdx].name}</div>}
                        {capColHasTitle && !capBoth && capTagEls(capTagLang)}
                        <p className="ar-caption-text">{descEn(arLabels[captionIdx])}</p>
                      </div>
                    )}
                  </div>
                  {/* 4辺のリサイズハンドル。左右=横幅 / 上下=縦に伸ばすと幅が狭まる。文字サイズは固定。出力には出ない。 */}
                  {(["l", "r", "t", "b"] as const).map((s) => (
                    <span
                      key={s}
                      className={`ar-cap-handle ar-cap-handle--${s}`}
                      title={s === "l" || s === "r" ? "幅を変える" : "縦に伸ばす（幅が狭まる）"}
                      onPointerDown={onCapResizeDown}
                      onPointerMove={onEditMove}
                      onPointerUp={onEditUp}
                    />
                  ))}
                </div>
              )}
            {/* 3Dミニマップ・スタンプのプレビュー。オン時のみ。書き出しは bakeComposite が再生成。
                対象山が見つからない場合（peak 未選択 ＋ 近傍に山岳データ無し）は
                撮影地点の座標だけを表示し、トグルが効いていることが分かるようにする。 */}
            {stampOn && stampPreview && (
              <div
                className={`ar-stamp ar-stamp--${stampCorner}`}
                style={{ "--stamp-accent": stampAccent } as React.CSSProperties}
              >
                <img src={stampPreview.url} alt="" className="ar-stamp-img" draggable={false} />
                {stampShowInfo && (
                  <div className="ar-stamp-info">
                    {stampPreview.mountain ? (
                      <>
                        <div className="ar-stamp-name">{stampPreview.mountain.name}</div>
                        <div className="ar-stamp-meta">
                          <span className="ar-stamp-elev">{Math.round(stampPreview.mountain.elevationM)}m</span>
                        </div>
                        <div className="ar-stamp-coord">
                          {formatLatLonShort(stampPreview.mountain.lat, stampPreview.mountain.lon)}
                        </div>
                      </>
                    ) : arLoc ? (
                      <>
                        <div className="ar-stamp-name">撮影地点</div>
                        <div className="ar-stamp-coord">{formatLatLonShort(arLoc.lat, arLoc.lon)}</div>
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            )}
            </div>
          </div>
          <div
            className="cam-hud"
            ref={camHudRef}
            style={{ transform: `translate(calc(-50% + ${arDockOffset.x}px), ${arDockOffset.y}px)` }}
          >
            <div
              className="cam-hud-grip ar-panel-grip"
              onPointerDown={onDockGripDown}
            >
              {arStepsBar}
              <button
                className="ar-panel-toggle"
                title={arPanelOpen ? "畳む（写真を大きく）" : "開く"}
                aria-label={arPanelOpen ? "畳む" : "開く"}
                onClick={() => setArPanelOpen((o) => !o)}
              >
                <IconCaret dir={arPanelOpen ? "down" : "up"} size={16} />
              </button>
            </div>
            {arPanelOpen && (
              <>
                <div className="cam-hud-body">
                {announce(
                  arLabels.length > 0
                    ? `「編集」で名札と解説をドラッグして配置、「画像」で写真の位置と大きさを調整します（切り替えで誤操作を防げます）。下のタブで文字・色・切り抜き・余白も仕上げられます。山名 ${arLabels.length}件。`
                    : "枠の中に山が入っていません。ひとつ戻って、向きや画角を合わせ直してください。",
                )}
                {/* ラベル・解説・操作（編集/画像＋ズーム）をタブで1つだけ表示。ARは操作を末尾に。 */}
                {dockTabs("arexport", [
                  arLabels.length > 0
                    ? {
                        id: "label",
                        label: (
                          <>
                            <IconMountain size={13} /> 山名
                          </>
                        ),
                        content: (
                          <>
                            {arSec(
                              "label-common",
                              "コモン",
                              <>
                                <label className="switch-row">
                                  <span>写真に山名を入れる</span>
                                  <input
                                    type="checkbox"
                                    className="switch"
                                    checked={bakeLabels}
                                    onChange={(e) => setBakeLabels(e.target.checked)}
                                  />
                                </label>
                                {bakeLabels && (
                                  <>
                                    <div className="ar-fs-row">
                                      <span>表示</span>
                                      <div className="ar-font-sel">
                                        <select
                                          value={labelMode}
                                          onChange={(e) => setLabelMode(e.target.value as LabelMode)}
                                          aria-label="ラベルの表示内容"
                                        >
                                          <option value="jaSubEnElev">日本語名 ＋ 英語名・標高</option>
                                          <option value="jaSubEn">日本語名 ＋ 英語名</option>
                                          <option value="jaSubElev">日本語名 ＋ 標高</option>
                                          <option value="enSubElev">英語名 ＋ 標高</option>
                                          <option value="jaOnly">日本語名のみ</option>
                                          <option value="enOnly">英語名のみ</option>
                                        </select>
                                      </div>
                                    </div>
                                    <div className="ar-fs-row">
                                      <span>背景パネル</span>
                                      <div className="seg" role="group" aria-label="背景パネル">
                                        {([["なし", "none"], ["半透明", "translucent"]] as [string, BgPanel][]).map(([lab, v]) => (
                                          <button key={v} className={labelBg === v ? "is-active" : ""} onClick={() => setLabelBg(v)}>
                                            {lab}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                    <div className="ar-fs-row">
                                      <span>文字の色</span>
                                      <input
                                        type="color"
                                        className="ar-color-input"
                                        value={labelColor}
                                        onChange={(e) => setLabelColor(e.target.value)}
                                        aria-label="文字の色"
                                      />
                                    </div>
                                    <label className="switch-row">
                                      <span>文字の影</span>
                                      <input
                                        type="checkbox"
                                        className="switch"
                                        checked={labelShadow}
                                        onChange={(e) => setLabelShadow(e.target.checked)}
                                      />
                                    </label>
                                  </>
                                )}
                              </>,
                            )}
                            {bakeLabels &&
                              arSec(
                                "label-main",
                                "メイン（山名）",
                                <>
                                  <div className="ar-fs-slider-row">
                                    <span>山名サイズ</span>
                                    <span className="ar-fs-val">{Math.round(labelNameScale * 100)}%</span>
                                  </div>
                                  <input
                                    type="range"
                                    className="ar-fs-slider"
                                    min={0.7}
                                    max={2.0}
                                    step={0.05}
                                    value={labelNameScale}
                                    onChange={(e) => setLabelNameScale(Number(e.target.value))}
                                    aria-label="山名サイズ"
                                  />
                                  {fontRow("labelName", "山名フォント")}
                                </>,
                              )}
                            {bakeLabels &&
                              labelHasSub &&
                              arSec(
                                "label-sub",
                                "サブ（補足）",
                                <>
                                  <div className="ar-fs-slider-row">
                                    <span>補足サイズ</span>
                                    <span className="ar-fs-val">{Math.round(labelSubScale * 100)}%</span>
                                  </div>
                                  <input
                                    type="range"
                                    className="ar-fs-slider"
                                    min={0.7}
                                    max={1.6}
                                    step={0.05}
                                    value={labelSubScale}
                                    onChange={(e) => setLabelSubScale(Number(e.target.value))}
                                    aria-label="補足サイズ"
                                  />
                                  {fontRow("labelSub", "補足フォント")}
                                </>,
                              )}
                          </>
                        ),
                      }
                    : null,
                  arLabels.some((l) => l.description)
                    ? {
                        id: "desc",
                        label: (
                          <>
                            <IconInfo size={13} /> 解説
                          </>
                        ),
                        content: (
                          <>
                            {arSec(
                              "desc-common",
                              "コモン",
                              <>
                                <div className="ar-fs-row">
                                  <span>言語</span>
                                  <div className="seg" role="group" aria-label="解説の言語">
                                    {(
                                      [
                                        ["日本語", "ja"],
                                        ["英語", "en"],
                                        ["両方", "both"],
                                        ["なし", "none"],
                                      ] as [string, "ja" | "en" | "both" | "none"][]
                                    ).map(([lab, v]) => (
                                      <button key={v} className={captionLang === v ? "is-active" : ""} onClick={() => setCaptionLang(v)}>
                                        {lab}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                {captionLang === "both" && (
                                  <div className="ar-fs-row">
                                    <span>並べ方</span>
                                    <div className="seg" role="group" aria-label="日英の並べ方">
                                      {([["横", "horizontal"], ["縦", "vertical"]] as [string, "horizontal" | "vertical"][]).map(([lab, v]) => (
                                        <button key={v} className={captionLayout === v ? "is-active" : ""} onClick={() => setCaptionLayout(v)}>
                                          {lab}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {captionLang === "both" && (
                                  <div className="ar-fs-row">
                                    <span>見出し</span>
                                    <div className="ar-font-sel">
                                      <select
                                        value={captionTitleMode}
                                        onChange={(e) => setCaptionTitleMode(e.target.value as "each" | "groupV" | "groupH" | "ja" | "en")}
                                        aria-label="見出しの出し方"
                                      >
                                        <option value="each">本文ごと</option>
                                        <option value="groupV">まとめる（上下）</option>
                                        <option value="groupH">まとめる（左右）</option>
                                        <option value="ja">日本語のみ</option>
                                        <option value="en">英語のみ</option>
                                      </select>
                                    </div>
                                  </div>
                                )}
                                {bakeCaption && (
                                  <>
                                    <div className="ar-fs-row">
                                      <span>背景パネル</span>
                                      <div className="seg" role="group" aria-label="背景パネル">
                                        {([["なし", "none"], ["半透明", "translucent"]] as [string, BgPanel][]).map(([lab, v]) => (
                                          <button key={v} className={captionBg === v ? "is-active" : ""} onClick={() => setCaptionBg(v)}>
                                            {lab}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                    <div className="ar-fs-row">
                                      <span>文字の色</span>
                                      <input
                                        type="color"
                                        className="ar-color-input"
                                        value={captionColor}
                                        onChange={(e) => setCaptionColor(e.target.value)}
                                        aria-label="文字の色"
                                      />
                                    </div>
                                    <label className="switch-row">
                                      <span>文字の影</span>
                                      <input
                                        type="checkbox"
                                        className="switch"
                                        checked={captionShadow}
                                        onChange={(e) => setCaptionShadow(e.target.checked)}
                                      />
                                    </label>
                                  </>
                                )}
                                {bakeCaption && arLabels.filter((l) => l.description).length > 1 && (
                                  <>
                                    <div className="ar-fs-row">
                                      <span>取り上げる山</span>
                                    </div>
                                    <div className="ar-caption-pick">
                                      {arLabels.map((l, i) =>
                                        l.description ? (
                                          <button
                                            key={i}
                                            className={`ar-cap-chip${i === captionIdx ? " is-on" : ""}`}
                                            onClick={() => setCaptionIdx(i)}
                                          >
                                            {l.name}
                                          </button>
                                        ) : null,
                                      )}
                                    </div>
                                  </>
                                )}
                              </>,
                            )}
                            {bakeCaption &&
                              arSec(
                                "desc-main",
                                "タイトル",
                                <>
                                  <div className="ar-fs-slider-row">
                                    <span>タイトルサイズ</span>
                                    <span className="ar-fs-val">{Math.round(captionTitleScale * 100)}%</span>
                                  </div>
                                  <input
                                    type="range"
                                    className="ar-fs-slider"
                                    min={0.7}
                                    max={2.0}
                                    step={0.05}
                                    value={captionTitleScale}
                                    onChange={(e) => setCaptionTitleScale(Number(e.target.value))}
                                    aria-label="解説タイトルサイズ"
                                  />
                                  {fontRow("captionTitle", "タイトルフォント")}
                                </>,
                              )}
                            {captionLang !== "none" &&
                              arSec(
                                "desc-tag",
                                "タグ",
                                <>
                                  <div className="ar-caption-pick">
                                    <button className={`ar-cap-chip${capShowElev ? " is-on" : ""}`} onClick={() => setCapShowElev((v) => !v)}>
                                      高さ
                                    </button>
                                    <button className={`ar-cap-chip${capShowLoc ? " is-on" : ""}`} onClick={() => setCapShowLoc((v) => !v)}>
                                      場所
                                    </button>
                                    {(capItem?.tagsJa ?? []).map((t) => (
                                      <button
                                        key={t}
                                        className={`ar-cap-chip${capSelectedTags.includes(t) ? " is-on" : ""}`}
                                        onClick={() => toggleCapTag(t)}
                                      >
                                        {t}
                                      </button>
                                    ))}
                                  </div>
                                  <div className="ar-fs-row">
                                    <span>タグの色</span>
                                    <input
                                      type="color"
                                      className="ar-color-input"
                                      value={tagColor}
                                      onChange={(e) => setTagColor(e.target.value)}
                                      aria-label="タグの色"
                                    />
                                  </div>
                                  <div className="ar-fs-row">
                                    <span>色の使い方</span>
                                    <div className="seg" role="group" aria-label="タグの色の使い方">
                                      {([["背景", "bg"], ["文字", "text"]] as [string, "bg" | "text"][]).map(([lab, v]) => (
                                        <button key={v} className={tagColorTarget === v ? "is-active" : ""} onClick={() => setTagColorTarget(v)}>
                                          {lab}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </>,
                              )}
                            {bakeCaption &&
                              arSec(
                                "desc-sub",
                                "ディスクリプション",
                                <>
                                  <div className="ar-fs-row">
                                    <span>長さ</span>
                                    <div className="seg" role="group" aria-label="解説の長さ">
                                      {([["短め", "short"], ["長め", "long"]] as [string, "short" | "long"][]).map(([lab, v]) => (
                                        <button key={v} className={captionLength === v ? "is-active" : ""} onClick={() => setCaptionLength(v)}>
                                          {lab}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="ar-fs-slider-row">
                                    <span>本文サイズ</span>
                                    <span className="ar-fs-val">{Math.round(captionBodyScale * 100)}%</span>
                                  </div>
                                  <input
                                    type="range"
                                    className="ar-fs-slider"
                                    min={0.7}
                                    max={1.6}
                                    step={0.05}
                                    value={captionBodyScale}
                                    onChange={(e) => setCaptionBodyScale(Number(e.target.value))}
                                    aria-label="解説本文サイズ"
                                  />
                                  {fontRow("captionBody", "本文フォント")}
                                </>,
                              )}
                          </>
                        ),
                      }
                    : null,
                  {
                    id: "stamp",
                    label: (
                      <>
                        <IconMap size={13} /> ミニマップ
                      </>
                    ),
                    content: (
                      <>
                        {arSec(
                          "stamp-common",
                          "コモン",
                          <>
                            <label className="switch-row">
                              <span>3Dミニマップを入れる</span>
                              <input
                                type="checkbox"
                                className="switch"
                                checked={stampOn}
                                onChange={(e) => setStampOn(e.target.checked)}
                              />
                            </label>
                            {stampOn && (
                              <>
                                <div className="ar-fs-row">
                                  <span>スタイル</span>
                                  <div className="seg" role="group" aria-label="地形スタイル">
                                    {(
                                      [
                                        ["等高線", "contour"],
                                        ["陰影", "shaded"],
                                        ["ワイヤー", "wire"],
                                      ] as [string, StampStyle][]
                                    ).map(([lab, v]) => (
                                      <button
                                        key={v}
                                        className={stampStyle === v ? "is-active" : ""}
                                        onClick={() => setStampStyle(v)}
                                      >
                                        {lab}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div className="ar-fs-row">
                                  <span>位置</span>
                                  <div className="seg" role="group" aria-label="スタンプの位置">
                                    {(
                                      [
                                        ["左上", "tl"],
                                        ["右上", "tr"],
                                        ["左下", "bl"],
                                        ["右下", "br"],
                                      ] as [string, "tl" | "tr" | "bl" | "br"][]
                                    ).map(([lab, v]) => (
                                      <button
                                        key={v}
                                        className={stampCorner === v ? "is-active" : ""}
                                        onClick={() => setStampCorner(v)}
                                      >
                                        {lab}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                <div className="ar-fs-row">
                                  <span>向き</span>
                                  <div className="seg" role="group" aria-label="スタンプの向き">
                                    <button
                                      className={stampOrient === "heading" ? "is-active" : ""}
                                      onClick={() => setStampOrient("heading")}
                                      disabled={arHeadingDeg == null}
                                      title={arHeadingDeg == null ? "撮影方位の情報がありません" : ""}
                                    >
                                      撮影方位
                                    </button>
                                    <button
                                      className={stampOrient === "north" ? "is-active" : ""}
                                      onClick={() => setStampOrient("north")}
                                    >
                                      北を上
                                    </button>
                                  </div>
                                </div>
                                {arHeadingDeg == null && (
                                  <p className="dock-announce" style={{ fontSize: "0.75em", opacity: 0.7 }}>
                                    撮影方位の情報がありません。北上で表示します。
                                  </p>
                                )}
                                <label className="switch-row">
                                  <span>情報（山名・標高・座標）</span>
                                  <input
                                    type="checkbox"
                                    className="switch"
                                    checked={stampShowInfo}
                                    onChange={(e) => setStampShowInfo(e.target.checked)}
                                  />
                                </label>
                              </>
                            )}
                          </>,
                        )}
                        {stampOn &&
                          arSec(
                            "stamp-range",
                            "範囲",
                            <>
                              <div className="ar-fs-slider-row">
                                <span>範囲</span>
                                <span className="ar-fs-val">{stampRangeKm.toFixed(1)} km</span>
                              </div>
                              <input
                                type="range"
                                className="ar-fs-slider"
                                min={1.5}
                                max={15}
                                step={0.5}
                                value={stampRangeKm}
                                onChange={(e) => setStampRangeKm(Number(e.target.value))}
                                aria-label="スタンプの範囲(km)"
                              />
                            </>,
                          )}
                        {/* アクセント色は「陰影」スタイルでは可視化要素がほぼ無い（ピン頭のみ）ため非表示。 */}
                        {stampOn &&
                          stampStyle !== "shaded" &&
                          arSec(
                            "stamp-color",
                            "アクセント色",
                            <>
                              <div className="ar-fs-row">
                                <span>アクセント色</span>
                                <input
                                  type="color"
                                  className="ar-color-input"
                                  value={stampAccent}
                                  onChange={(e) => setStampAccent(e.target.value)}
                                  aria-label="スタンプのアクセント色"
                                />
                              </div>
                              <div className="ar-caption-pick">
                                {["#d6b46a", "#8be1ff", "#ffb95a", "#ff7a8a", "#ffffff"].map((c) => (
                                  <button
                                    key={c}
                                    type="button"
                                    className={`ar-cap-chip${stampAccent.toLowerCase() === c.toLowerCase() ? " is-on" : ""}`}
                                    style={{ background: c, color: "#0e1620" }}
                                    onClick={() => setStampAccent(c)}
                                    aria-label={`アクセント色 ${c}`}
                                  >
                                    ●
                                  </button>
                                ))}
                              </div>
                            </>,
                          )}
                      </>
                    ),
                  },
                  {
                    id: "crop",
                    label: (
                      <>
                        <IconImage size={13} /> 切抜
                      </>
                    ),
                    content: (
                      <>
                        {(["t", "b", "l", "r"] as const).map((d) => (
                          <div key={`crop-${d}`}>
                            <div className="ar-fs-slider-row">
                              <span>{`切抜 ${{ t: "上", b: "下", l: "左", r: "右" }[d]}`}</span>
                              <span className="ar-fs-val">{Math.round(cropInset[d] * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              className="ar-fs-slider"
                              min={0}
                              max={0.45}
                              step={0.01}
                              value={cropInset[d]}
                              onChange={(e) => setCropInset((p) => ({ ...p, [d]: Number(e.target.value) }))}
                            />
                          </div>
                        ))}
                      </>
                    ),
                  },
                  {
                    id: "margin",
                    label: (
                      <>
                        <IconGrid size={13} /> 余白
                      </>
                    ),
                    content: (
                      <>
                        <div className="ar-fs-row">
                          <span>余白の色</span>
                          <input
                            type="color"
                            className="ar-color-input"
                            value={frameMarginColor}
                            onChange={(e) => setFrameMarginColor(e.target.value)}
                            aria-label="余白の色"
                          />
                        </div>
                        {(["t", "b", "l", "r"] as const).map((d) => (
                          <div key={`margin-${d}`}>
                            <div className="ar-fs-slider-row">
                              <span>{`余白 ${{ t: "上", b: "下", l: "左", r: "右" }[d]}`}</span>
                              <span className="ar-fs-val">{Math.round(frameMargin[d] * 100)}%</span>
                            </div>
                            <input
                              type="range"
                              className="ar-fs-slider"
                              min={0}
                              max={1.2}
                              step={0.01}
                              value={frameMargin[d]}
                              onChange={(e) => setFrameMargin((p) => ({ ...p, [d]: Number(e.target.value) }))}
                            />
                          </div>
                        ))}
                        <div className="ar-fs-slider-row">
                          <span>ふち（グラデーション）</span>
                          <span className="ar-fs-val">{Math.round(frameFade * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          className="ar-fs-slider"
                          min={0}
                          max={0.5}
                          step={0.01}
                          value={frameFade}
                          onChange={(e) => setFrameFade(Number(e.target.value))}
                        />
                      </>
                    ),
                  },
                  {
                    id: "view",
                    label: (
                      <>
                        <IconMove size={13} /> 操作
                      </>
                    ),
                    content: (
                      <div className="stage-controls">
                        {exportModeToggle}
                        {stageZoomControls}
                      </div>
                    ),
                  },
                ])}
                </div>
                <div className="ar-dock-actions">
                  <button
                    className="ar-btn-sub ar-btn--icon"
                    title="微調整へ戻る"
                    aria-label="微調整へ戻る"
                    onClick={backToAlignFromExport}
                  >
                    <IconChevron dir="left" size={18} />
                  </button>
                  <button className="ar-btn-main" disabled={arLabels.length === 0} onClick={downloadComposite}>
                    <IconDownload size={15} />
                    ダウンロード
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 中心レティクル（注視点＝画面中央の目印）。ARでは撮影地点ピンを使うので出さない。 */}
      {isSim && mode === "map" && showCenter && (
        <svg ref={reticleRef} className="center-reticle" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
          <circle cx="16" cy="16" r="8.5" fill="none" stroke="#d6b46a" strokeWidth="1.6" />
          <circle cx="16" cy="16" r="1.5" fill="#d6b46a" />
          <line x1="16" y1="2.5" x2="16" y2="6.5" stroke="#d6b46a" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="16" y1="25.5" x2="16" y2="29.5" stroke="#d6b46a" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="2.5" y1="16" x2="6.5" y2="16" stroke="#d6b46a" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="25.5" y1="16" x2="29.5" y2="16" stroke="#d6b46a" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}

      {/* 表示設定はホーム画面の「表示設定」パネルへ移設（旧☰メニューは廃止）。 */}
      {locError && mode === "map" && <div className="locate-warn">{locError}</div>}

      {/* 共有リンクのコピー（地形・太陽月のみ。今の中心地点を入れたURL）。ホームの左隣。 */}
      {canShare && (
        <button className="share-btn" title="今の場所への共有リンクをコピー" onClick={shareCurrentView}>
          <IconLink size={15} /> {shareCopied ? "コピーしました ✓" : "リンクをコピー"}
        </button>
      )}
      {/* ホームへ戻る（右上の右端。押し間違い防止で左の操作群と離す）。 */}
      <button className="home-btn" title="ホーム画面へ戻る" aria-label="ホーム" onClick={onHome}>
        <IconHome size={18} />
      </button>


      {/* 山頂選択の一括解除チップ（シミュレーションのみ。ARは選択フェーズのUIで扱う） */}
      {isSim && showPeaks && peakSelCount > 0 && (
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
        <div
          className="cam-hud"
          ref={camHudRef}
          style={{ transform: `translate(calc(-50% + ${arDockOffset.x}px), ${arDockOffset.y}px)` }}
        >
          <div
            className="cam-hud-grip ar-panel-grip"
            onPointerDown={onDockGripDown}
          >
            {arStepsBar}
            {simView && <span className="mode-panel-title">{modeTitle}</span>}
            <button
              className="ar-panel-toggle"
              title={arPanelOpen ? "畳む（縦画像を大きく）" : "開く"}
              aria-label={arPanelOpen ? "畳む" : "開く"}
              onClick={() => setArPanelOpen((o) => !o)}
            >
              <IconCaret dir={arPanelOpen ? "down" : "up"} size={16} />
            </button>
          </div>
          {arPanelOpen && (
          <>
          <div className="cam-hud-body">
          {/* アナウンス（タイトル直下） */}
          {simView
            ? announce("ドラッグで見回し、ホイールやピンチで画角を変えられます。「地図」で俯瞰に戻ります。")
            : arStep === "align"
              ? announce(
                  appMode === "live"
                    ? "選んだ山の名前がカメラ映像に重なります。ドラッグで向き、スライダーで目線の高さを合わせて確かめます。"
                    : "選んだ山の名前が写真に重なります。ドラッグで向き、スライダーで目線の高さと傾きを合わせ、ぴたりと重ねます。",
                )
              : null}
          {/* セクションはタブで1つだけ表示 */}
          {simView
            ? dockTabs("sim", [
                viewTab,
                {
                  id: "cam",
                  label: <><IconCamera size={13} /> カメラ設定</>,
                  content: (
                    <>
                      {cameraReadout}
                      {eyeSlider}
                      {fovSlider}
                      {rollSlider}
                    </>
                  ),
                },
                showCelestial
                  ? { id: "sun", label: <><IconSun size={13} /> 太陽・月</>, content: celestialControls }
                  : null,
              ])
            : dockTabs("align", [
                {
                  id: "cam",
                  label: <><IconCamera size={13} /> カメラ設定</>,
                  content: (
                    <>
                      {cameraReadout}
                      {eyeSlider}
                      {appMode !== "live" && rollSlider}
                      {appMode === "ar" &&
                        (!photoUrl ? (
                          <div className="cam-photo">
                            <button className="cam-photo-pick" onClick={() => photoInputRef.current?.click()}>
                              <IconImage size={15} />
                              <span>写真を重ねて合わせる</span>
                            </button>
                          </div>
                        ) : (
                          camSlider(
                            <>
                              写真の濃さ <i className="cam-eye-sub">シミュ ←→ 写真</i>
                            </>,
                            `${Math.round(photoOpacity * 100)}%`,
                            <input type="range" min={0} max={100} value={Math.round(photoOpacity * 100)} onChange={(e) => setPhotoOpacity(Number(e.target.value) / 100)} />,
                          )
                        ))}
                      {appMode === "live" &&
                        camSlider(
                          <>
                            カメラ映像の濃さ <i className="cam-eye-sub">シミュ ←→ カメラ</i>
                          </>,
                          `${Math.round(photoOpacity * 100)}%`,
                          <input type="range" min={0} max={100} value={Math.round(photoOpacity * 100)} onChange={(e) => setPhotoOpacity(Number(e.target.value) / 100)} />,
                        )}
                    </>
                  ),
                },
                // ARは「操作」を末尾に。
                {
                  id: "view",
                  label: <><IconMove size={13} /> 操作</>,
                  content: (
                    <>
                      {arLike && arStep === "align" && (
                        <div className="stage-controls">
                          {editModeToggle}
                          {stageZoomControls}
                        </div>
                      )}
                      {dockControls}
                    </>
                  ),
                },
              ])}
          </div>
          {/* 進行ボタン（最下部） */}
          {appMode === "ar" && arStep === "align" && (
            <div className="ar-dock-actions">
              <button
                className="ar-btn-sub ar-btn--icon"
                title="山選択へ戻る"
                aria-label="山選択へ戻る"
                onClick={() => switchViewWithFade({ kind: "phase", step: 3, name: "山選択" }, backToSelect)}
              >
                <IconChevron dir="left" size={18} />
              </button>
              <button className="ar-btn-main" title="仕上げ（次へ）" aria-label="仕上げ（次へ）" onClick={goExport}>
                次へ
                <IconChevron dir="right" size={18} />
              </button>
            </div>
          )}
          {appMode === "live" && arStep === "align" && (
            <div className="ar-dock-actions">
              <button
                className="ar-btn-sub ar-btn--icon"
                title="山選択へ戻る"
                aria-label="山選択へ戻る"
                onClick={() => switchViewWithFade({ kind: "phase", step: 3, name: "山選択" }, backToSelect)}
              >
                <IconChevron dir="left" size={18} />
              </button>
              <button className="ar-btn-main" onClick={onHome}>
                完了
              </button>
            </div>
          )}
          </>
          )}
        </div>
      )}

      {/* terrain/celestial/offline 共通の下部ドック（AR系と同じ：グリップで移動・折りたたみ）。1モード1パネル。 */}
      {isSim && mode === "map" && (
        <div
          className="mode-dock"
          ref={dockRef}
          style={{ transform: `translate(calc(-50% + ${arDockOffset.x}px), ${arDockOffset.y}px)` }}
        >
          <div className="cam-hud-grip ar-panel-grip" onPointerDown={onDockGripDown}>
            <span className="mode-panel-title">{modeTitle}</span>
            <button
              className="ar-panel-toggle"
              title={modePanelOpen ? "畳む" : "開く"}
              aria-label={modePanelOpen ? "畳む" : "開く"}
              onClick={() => setModePanelOpen((o) => !o)}
            >
              <IconCaret dir={modePanelOpen ? "down" : "up"} size={16} />
            </button>
          </div>
          {modePanelOpen && (
            <div className="mode-dock-body">
              {announce(modeHint)}
              {dockTabs("mode", [
                viewTab,
                { id: "search", label: <><IconSearch size={13} /> 検索</>, content: searchPanel },
                { id: "basemap", label: <><IconMap size={13} /> 地図</>, content: basemapPanel },
                showCelestial ? { id: "celest", label: <><IconSun size={13} /> 太陽・月</>, content: celestialControls } : null,
                isOffline ? { id: "save", label: <><IconDownload size={13} /> オフライン保存</>, content: offlineControls } : null,
              ])}
            </div>
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
