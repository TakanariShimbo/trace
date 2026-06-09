import { useRef, useState } from "react";
import Home from "./components/Home";
import MapView from "./components/MapView";
import { CARDS } from "./modeCards";

// 画面ルーター: ホーム → 各モード。3Dエンジン(MapView)は共通で、appMode で用途別に振る舞いを切り替える。
// terrain=地形 / celestial=太陽月 / ar=写真AR / live=カメラAR / offline=オフライン保存。
export type AppMode = "terrain" | "celestial" | "ar" | "live" | "offline";

export default function App() {
  const [screen, setScreen] = useState<"home" | AppMode>("home");
  // ホーム⇄モードの遷移を暗転でつなぐ。地図⇄風景と同じ演出で、入る時は行き先カードを出す。
  const [fade, setFade] = useState(0);
  const [card, setCard] = useState<{ icon: React.ReactNode; title: string } | null>(null);
  const busyRef = useRef(false);

  const navigate = (target: "home" | AppMode) => {
    if (busyRef.current || target === screen) return;
    busyRef.current = true;
    // 入る時は行き先モードのカードを表示。ホームへ戻る時はカードなしでサッと暗転。
    const meta = target === "home" ? null : CARDS.find((c) => c.mode === target);
    setCard(meta ? { icon: meta.icon, title: meta.title } : null);
    setFade(1); // 暗転（CSS 0.32s）
    window.setTimeout(() => {
      setScreen(target); // 暗転中に画面を入れ替え（MapView初期化・3D読込のチラつきも隠す）
      window.setTimeout(
        () => {
          setFade(0); // 明転
          busyRef.current = false;
          window.setTimeout(() => setCard(null), 360);
        },
        target === "home" ? 260 : 900, // モードは初期化を待って長めに黒を保持
      );
    }, 320);
  };

  return (
    <>
      {screen === "home" ? (
        <Home onSelect={navigate} />
      ) : (
        <MapView appMode={screen} onHome={() => navigate("home")} />
      )}
      {/* ホーム⇄モードの暗転フェード（最前面）。入る時は行き先カードを出す。 */}
      <div className={`screen-fade${fade ? " is-on" : ""}`} style={{ opacity: fade }} aria-hidden="true">
        {card && (
          <div className="view-fade-card">
            <span className="view-fade-ico">{card.icon}</span>
            <span className="view-fade-name">{card.title}</span>
          </div>
        )}
        {card && <span className="fade-loading">Loading…</span>}
      </div>
    </>
  );
}
