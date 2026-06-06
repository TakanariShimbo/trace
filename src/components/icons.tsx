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
