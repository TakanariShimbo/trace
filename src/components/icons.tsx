// UI 全体で使う線アイコン（stroke=currentColor のシンプルな SVG）。
// 絵文字より UI に馴染み、色・サイズを currentColor / size で揃えられる。

type Props = { size?: number; className?: string };

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className,
  };
}

/** 山（稜線シルエット）。検索結果の山名用。 */
export function IconMountain({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 19 L9 8 L13 14 L16.5 9 L21 19 Z" />
      <path d="M7.5 12.5 L9 11 L10.5 12.5" />
    </svg>
  );
}

/** 本（図鑑）。山の図鑑モード用。 */
export function IconBook({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 4.5 C4 3.7 4.7 3 5.5 3 H19 a1 1 0 0 1 1 1 V20 a1 1 0 0 1 -1 1 H5.5 C4.7 21 4 20.3 4 19.5 Z" />
      <path d="M4 17.5 C4 16.7 4.7 16 5.5 16 H20" />
      <path d="M8 7.5 H16 M8 11 H13.5" />
    </svg>
  );
}

/** リンク（鎖）。共有リンクのコピー用。 */
export function IconLink({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M10 14 a4 4 0 0 1 0 -5.6 l3.2 -3.2 a4 4 0 0 1 5.6 5.6 l-1.6 1.6" />
      <path d="M14 10 a4 4 0 0 1 0 5.6 l-3.2 3.2 a4 4 0 0 1 -5.6 -5.6 l1.6 -1.6" />
    </svg>
  );
}

/** 地図ピン。検索結果の土地名用。 */
export function IconPin({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 21 C12 21 19 14.7 19 9.5 A7 7 0 1 0 5 9.5 C5 14.7 12 21 12 21 Z" />
      <circle cx="12" cy="9.5" r="2.4" />
    </svg>
  );
}

/** ダウンロード（下向き矢印＋台）。事前保存用。 */
export function IconDownload({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3 L12 15" />
      <path d="M7 10 L12 15 L17 10" />
      <path d="M5 20 L19 20" />
    </svg>
  );
}

/** 画像（写真）。撮影画像の取り込み用。 */
export function IconImage({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M5 17 L10 12 L13 15 L16 12 L20 16" />
    </svg>
  );
}

/** 線のシェブロン（ボタンの前後ナビ用）。dir で左右。 */
export function IconChevron({ dir = "right", size = 16, className }: Props & { dir?: "left" | "right" }) {
  return (
    <svg {...svgProps(size, className)}>
      {dir === "right" ? <path d="M9.5 5 L16.5 12 L9.5 19" /> : <path d="M14.5 5 L7.5 12 L14.5 19" />}
    </svg>
  );
}

/** 三角キャレット（パン操作）。dir で向きを回す。 */
export function IconCaret({ dir = "up", size = 16, className }: Props & { dir?: "up" | "down" | "left" | "right" }) {
  const rot = { up: 0, right: 90, down: 180, left: 270 }[dir];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      style={{ transform: `rotate(${rot}deg)` }}
    >
      <polygon points="12,7 18,16 6,16" fill="currentColor" />
    </svg>
  );
}

/** 回転（円弧＋矢じり）。dir=ccw/cw で左右。 */
export function IconRotate({ dir = "ccw", size = 18, className }: Props & { dir?: "ccw" | "cw" }) {
  if (dir === "cw") {
    return (
      <svg {...svgProps(size, className)}>
        <path d="M21 12 a9 9 0 1 1 -3 -6.7" />
        <path d="M21 4 L21 8 L17 8" />
      </svg>
    );
  }
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 12 a9 9 0 1 0 3 -6.7" />
      <path d="M3 4 L3 8 L7 8" />
    </svg>
  );
}

/** ホーム（家）。日本全体に戻す用。 */
export function IconHome({ size = 18, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M4 11 L12 4 L20 11" />
      <path d="M6 10 L6 20 L18 20 L18 10" />
    </svg>
  );
}

/** プラス（ズームイン）。 */
export function IconPlus({ size = 18, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 6 L12 18" />
      <path d="M6 12 L18 12" />
    </svg>
  );
}

/** マイナス（ズームアウト）。 */
export function IconMinus({ size = 18, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M6 12 L18 12" />
    </svg>
  );
}

/** 太陽（円＋光条）。 */
export function IconSun({ size = 18, className }: Props) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return (
      <line
        key={i}
        x1={(12 + Math.cos(a) * 8).toFixed(2)}
        y1={(12 + Math.sin(a) * 8).toFixed(2)}
        x2={(12 + Math.cos(a) * 10.5).toFixed(2)}
        y2={(12 + Math.sin(a) * 10.5).toFixed(2)}
      />
    );
  });
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="5" />
      {rays}
    </svg>
  );
}

/** 月相ビジュアル。illuminated 割合(0-1)と waxing(右が光る) で満ち欠けを描く。 */
export function IconMoonPhase({
  fraction,
  waxing,
  size = 26,
  className,
}: Props & { fraction: number; waxing: boolean }) {
  const R = size / 2 - 1.2;
  const c = size / 2;
  const k = Math.min(Math.max(fraction, 0), 1);
  const a = R * Math.abs(2 * k - 1); // ターミネータ楕円の横半径
  const limbSweep = waxing ? 1 : 0;
  const termSweep = waxing ? (k > 0.5 ? 1 : 0) : k > 0.5 ? 0 : 1;
  const lit = `M ${c} ${c - R} A ${R} ${R} 0 0 ${limbSweep} ${c} ${c + R} A ${a.toFixed(2)} ${R} 0 0 ${termSweep} ${c} ${c - R} Z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden="true">
      <circle cx={c} cy={c} r={R} fill="#10151c" stroke="#39465c" strokeWidth="0.8" />
      {k > 0.004 && <path d={lit} fill="#dfe6f0" />}
    </svg>
  );
}

/** カメラ。 */
export function IconCamera({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M8.5 7 L10 4.8 H14 L15.5 7" />
      <circle cx="12" cy="13" r="3.1" />
    </svg>
  );
}

/** 地図（折り畳み地図）。 */
export function IconMap({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M9 4 L3 6 V20 L9 18 L15 20 L21 18 V4 L15 6 L9 4 Z" />
      <path d="M9 4 V18" />
      <path d="M15 6 V20" />
    </svg>
  );
}

/** 風景（山並み＋太陽）。地図(俯瞰)の対になる「その場に立った眺め」ビュー用。 */
export function IconLandscape({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="16.5" cy="7.5" r="2.5" />
      <path d="M2 19 L8 10.5 L12.5 16 L16 11.5 L22 19" />
    </svg>
  );
}

/** 現在地（GPSロケート）。十字＋中心の的。 */
export function IconLocate({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <path d="M12 1 L12 4" />
      <path d="M12 20 L12 23" />
      <path d="M1 12 L4 12" />
      <path d="M20 12 L23 12" />
    </svg>
  );
}

/** 立方体（3D表示）。アイソメトリックな箱。 */
export function IconCube({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3 L20 7.5 L12 12 L4 7.5 Z" />
      <path d="M4 7.5 L12 12 L12 21 L4 16.5 Z" />
      <path d="M20 7.5 L12 12 L12 21 L20 16.5 Z" />
    </svg>
  );
}

/** 平面グリッド（2D地図/真上）。 */
export function IconGrid({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
      <path d="M3.5 9.2 H20.5 M3.5 14.8 H20.5 M9.2 3.5 V20.5 M14.8 3.5 V20.5" />
    </svg>
  );
}

/** すべて（全部）。2×2のドットで「まとめて／全件」を表す。検索の「すべて」用。 */
export function IconAll({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="8.5" cy="8.5" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="15.5" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 四方向矢印（移動／パン）。 */
export function IconMove({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M12 3 L12 21 M3 12 L21 12" />
      <path d="M12 3 L9.5 5.5 M12 3 L14.5 5.5" />
      <path d="M12 21 L9.5 18.5 M12 21 L14.5 18.5" />
      <path d="M3 12 L5.5 9.5 M3 12 L5.5 14.5" />
      <path d="M21 12 L18.5 9.5 M21 12 L18.5 14.5" />
    </svg>
  );
}

/** 目（自由視点）。 */
export function IconEye({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M2 12 C5 6.5 19 6.5 22 12 C19 17.5 5 17.5 2 12 Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** インフォ（i）。アナウンス（案内文）の先頭マーク用。 */
export function IconInfo({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 虫めがね（検索）。検索セクションの見出し用。 */
export function IconSearch({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.5" y1="15.5" x2="21" y2="21" />
    </svg>
  );
}

/** 設定（スライダー＝調整ツマミ）。表示設定カードの見出し用。 */
export function IconSettings({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <line x1="4" y1="8.5" x2="20" y2="8.5" />
      <circle cx="9" cy="8.5" r="2.4" fill="currentColor" stroke="none" />
      <line x1="4" y1="15.5" x2="20" y2="15.5" />
      <circle cx="15" cy="15.5" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 大きな「T」（文字・タイトル）。ポスター風の中央タイトル（センタータイトル）用。 */
export function IconType({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M5 6 H19" />
      <path d="M12 6 V19" />
      <path d="M9 19 H15" />
    </svg>
  );
}

/** コンパス（向き・画角）。円＋方位ポインタ。向き・画角セクションの見出し用。 */
export function IconCompass({ size = 16, className }: Props) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5 L10.5 10.5 L8.5 15.5 L13.5 13.5 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
