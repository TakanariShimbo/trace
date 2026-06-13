// 表示設定の専用画面。ホームのカードから入り、ここで変えた内容が各モードに引き継がれる。
// 旧・各モードの☰メニュー（サイドバー）の中身をこの画面にまとめた。
import { IconHome } from "./icons";
import type { Settings } from "../settings";

type Props = {
  settings: Settings;
  onChangeSettings: (next: Settings) => void;
  onHome: () => void; // ホーム画面へ戻る。
};

export default function SettingsScreen({ settings, onChangeSettings, onHome }: Props) {
  // 設定の一部だけを差し替えて更新する。
  const set = (patch: Partial<Settings>) => onChangeSettings({ ...settings, ...patch });

  return (
    <div className="home">
      {/* ホームへ戻る（右上。各モードと同じ位置・見た目）。 */}
      <button className="home-btn" title="ホーム画面へ戻る" aria-label="ホーム" onClick={onHome}>
        <IconHome size={18} />
      </button>

      <div className="home-inner">
        <header className="home-head">
          <h1>表示を整える</h1>
          <p>各モードに引き継がれます</p>
        </header>

        <section className="home-settings">
          <label className="switch-row">
            <span>中心マーカー</span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.showCenter}
              onChange={(e) => set({ showCenter: e.target.checked })}
            />
          </label>
          <label className="switch-row">
            <span>山頂マーカー</span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.showPeaks}
              onChange={(e) => set({ showPeaks: e.target.checked })}
            />
          </label>
          <label className="switch-row">
            <span>空のグラデーション</span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.showSky}
              onChange={(e) => set({ showSky: e.target.checked })}
            />
          </label>
          <div className="slider-row">
            <span className="slider-label">
              標高の誇張（地図）
              <b>×{settings.mapVex.toFixed(1)}</b>
              {settings.mapVex === 1 ? " 実寸" : ""}
            </span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={settings.mapVex}
              onChange={(e) => set({ mapVex: Number(e.target.value) })}
            />
          </div>
          <div className="slider-row">
            <span className="slider-label">
              標高の誇張（風景）
              <b>×{settings.camVex.toFixed(1)}</b>
              {settings.camVex === 1 ? " 実寸" : ""}
            </span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.1}
              value={settings.camVex}
              onChange={(e) => set({ camVex: Number(e.target.value) })}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
