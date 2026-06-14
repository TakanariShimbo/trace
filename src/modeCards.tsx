// ホーム画面のカード定義（一覧と、画面遷移の暗転カードで共用）。
// 用途別モード（MapView）に加え、表示設定・図鑑の専用画面もカードから入る。
// タイトルは「短い日本語の動詞形」で統一（名詞混在を避ける）。説明は「〜できます/ます」。
import { IconMountain, IconSun, IconImage, IconCamera, IconDownload, IconSettings, IconBook } from "./components/icons";
import type { AppMode } from "./App";

export const CARDS: { mode: AppMode | "settings" | "zukan"; icon: React.ReactNode; title: string; desc: string }[] = [
  {
    mode: "zukan",
    icon: <IconBook size={26} />,
    title: "山を知る",
    desc: "日本の山を、名前・標高・地域・タグから探します。",
  },
  {
    mode: "terrain",
    icon: <IconMountain size={26} />,
    title: "地形を読む",
    desc: "3D地形で山並みを眺め、その場に立った景色も見渡せます。",
  },
  {
    mode: "celestial",
    icon: <IconSun size={26} />,
    title: "光を読む",
    desc: "太陽と月の方角・高さ、日の出入りを確認します。",
  },
  {
    mode: "ar",
    icon: <IconImage size={26} />,
    title: "山を写す",
    desc: "写真に山名ラベルや好きな文字を重ねて、印象的な一枚に仕上げます。",
  },
  {
    mode: "live",
    icon: <IconCamera size={26} />,
    title: "山を見分ける",
    desc: "カメラに映る山の名前をその場で重ね、目の前の山がどれかを確かめます。",
  },
  {
    mode: "offline",
    icon: <IconDownload size={26} />,
    title: "オフラインに備える",
    desc: "電波の届かない場所でも見られるよう、範囲を保存します。",
  },
  {
    mode: "settings",
    icon: <IconSettings size={26} />,
    title: "表示を整える",
    desc: "マーカーや空、標高の誇張などの表示を切り替えます。",
  },
];
