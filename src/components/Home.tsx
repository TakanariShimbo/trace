// アプリのホーム画面。入場時に出し、ここから用途別モード／表示設定へ分岐する。
import type { Screen } from "../App";
import { CARDS } from "../modeCards";

type Props = { onSelect: (target: Exclude<Screen, "home">) => void };

export default function Home({ onSelect }: Props) {
  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1>Trace</h1>
          <p>Find Your Frame ― 山で写真を撮る人のための、撮影計画・AR・作品づくり</p>
        </header>
        <div className="home-cards">
          {CARDS.map((c) => (
            <button key={c.mode} className="home-card" onClick={() => onSelect(c.mode)}>
              <span className="home-card-icon">{c.icon}</span>
              <span className="home-card-text">
                <span className="home-card-title">{c.title}</span>
                <span className="home-card-desc">{c.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
