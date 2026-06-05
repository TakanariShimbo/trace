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
