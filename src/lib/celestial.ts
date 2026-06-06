// 太陽・月の位置（方位・高度）と月の満ち欠けを計算する薄いラッパー。
// 天文計算は suncalc に委譲。mount-photo-sim から移植。
//
// suncalc の方位は「南=0, 西へ正」のラジアン。これをコンパス方位（北=0, 東=90, 時計回り）
// の度に変換して返す。

import { getPosition, getMoonPosition, getMoonIllumination, getTimes } from "suncalc";

export type SkyBody = {
  azimuthDeg: number; // コンパス方位（0=北, 90=東）
  altitudeDeg: number; // 地平線=0, 天頂=90
  visible: boolean; // 地平線より上か
};

export type SkyState = {
  sun: SkyBody;
  moon: SkyBody;
  moonFraction: number; // 月の照らされている割合 0..1
  moonWaxing: boolean; // 満ちていく途中（true=右側が光る／false=欠けていく＝左側）
  moonPhase: number; // 月相 0=新月 0.25=上弦 0.5=満月 0.75=下弦 1=新月
  sunrise: Date | null;
  sunset: Date | null;
};

const HORIZON_MARGIN_DEG = -0.5;

function toCompassDeg(azimuthRad: number): number {
  return ((azimuthRad * 180) / Math.PI + 180 + 360) % 360;
}
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** 太陽 or 月の軌跡（中心時刻の ±hours 時間、stepMin 分刻み）。地平線下も含む。 */
export function computeTrack(
  center: Date,
  lat: number,
  lon: number,
  body: "sun" | "moon",
  hours = 8,
  stepMin = 20,
): SkyBody[] {
  const out: SkyBody[] = [];
  const start = center.getTime() - hours * 3600_000;
  const end = center.getTime() + hours * 3600_000;
  const stepMs = stepMin * 60_000;
  for (let t = start; t <= end; t += stepMs) {
    const d = new Date(t);
    const p = body === "sun" ? getPosition(d, lat, lon) : getMoonPosition(d, lat, lon);
    const alt = toDeg(p.altitude);
    out.push({
      azimuthDeg: toCompassDeg(p.azimuth),
      altitudeDeg: alt,
      visible: alt > HORIZON_MARGIN_DEG,
    });
  }
  return out;
}

export function computeSky(date: Date, lat: number, lon: number): SkyState {
  const s = getPosition(date, lat, lon);
  const m = getMoonPosition(date, lat, lon);
  const ill = getMoonIllumination(date);
  const times = getTimes(date, lat, lon);
  const sunAlt = toDeg(s.altitude);
  const moonAlt = toDeg(m.altitude);
  const valid = (d: Date) => (Number.isNaN(d.getTime()) ? null : d);
  return {
    sun: {
      azimuthDeg: toCompassDeg(s.azimuth),
      altitudeDeg: sunAlt,
      visible: sunAlt > HORIZON_MARGIN_DEG,
    },
    moon: {
      azimuthDeg: toCompassDeg(m.azimuth),
      altitudeDeg: moonAlt,
      visible: moonAlt > HORIZON_MARGIN_DEG,
    },
    moonFraction: ill.fraction,
    moonWaxing: ill.phase < 0.5,
    moonPhase: ill.phase,
    sunrise: valid(times.sunrise),
    sunset: valid(times.sunset),
  };
}
