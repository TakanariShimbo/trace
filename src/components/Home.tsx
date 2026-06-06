// アプリのホーム画面。入場時に出し、ここから用途別モードへ分岐する。
// 「地形を見る」＝3D地形の俯瞰・一人称ビュー。「写真に山名をのせる」＝写真へのAR合成。
// 「今撮る（ライブAR）」は将来枠のため当面は出さない。
import { IconMountain, IconImage } from "./icons";

type Props = { onSelect: (mode: "simulation" | "ar") => void };

export default function Home({ onSelect }: Props) {
  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1>GSI 3D Map</h1>
          <p>国土地理院の標高データでつくる、日本の3D地形マップ</p>
        </header>
        <div className="home-cards">
          <button className="home-card" onClick={() => onSelect("simulation")}>
            <span className="home-card-icon">
              <IconMountain size={30} />
            </span>
            <span className="home-card-title">地形を見る</span>
            <span className="home-card-desc">日本の地形を3Dで俯瞰。好きな地点に立って自由に見回せます</span>
          </button>
          <button className="home-card" onClick={() => onSelect("ar")}>
            <span className="home-card-icon">
              <IconImage size={30} />
            </span>
            <span className="home-card-title">写真に山名をのせる</span>
            <span className="home-card-desc">撮った山の写真に山名を重ね、合成画像を書き出せます（AR）</span>
          </button>
        </div>
      </div>
    </div>
  );
}
