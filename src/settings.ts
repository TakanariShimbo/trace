// 表示設定。以前は各モードのサイドバー（☰メニュー）で変更していたが、
// ホーム画面の「表示設定」パネルにまとめ、各モードへ引き継ぐ。
// localStorage に保存して再読込でも保持する。
import { useEffect, useState } from "react";

export type Settings = {
  showCenter: boolean; // 中心マーカー（画面中央のレティクル）
  showPeaks: boolean; // 山頂マーカー・山名ラベル
  showSky: boolean; // 空のグラデーション
  mapVex: number; // 標高の誇張（地図／俯瞰）×1=実寸
  camVex: number; // 標高の誇張（風景／カメラ視点）×1=実寸
};

export const DEFAULT_SETTINGS: Settings = {
  showCenter: true,
  showPeaks: true,
  showSky: true,
  mapVex: 1.7, // 地図モードの既定
  camVex: 1.0, // カメラ視点モードの既定（実寸）
};

const STORAGE_KEY = "trace.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // 破損・非対応環境は既定値で続行
  }
  return DEFAULT_SETTINGS;
}

// 設定を localStorage に保存しながら扱うフック（ホーム⇄各モードで共有）。
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // 保存できなくても致命的ではない
    }
  }, [settings]);
  return [settings, setSettings] as const;
}
