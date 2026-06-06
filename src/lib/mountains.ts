// 山名検索。隣プロジェクト由来の山岳データ（public/data/mountains.json、約1,061山）を
// 使い、名前・読み(カナ)で部分一致検索する。正確な山頂座標と標高を持つのでオフライン可。
//   出典: 「日本の主な山岳標高一覧」（国土地理院）を加工。

type MountainRecord = {
  name: string;
  name_kana?: string;
  latitude: number;
  longitude: number;
  elevation_m: number;
  prefecture?: string;
  priority: number;
};

export type MountainHit = {
  name: string;
  lat: number;
  lon: number;
  elevationM: number;
  prefecture?: string;
};

let cache: MountainRecord[] | null = null;
let loading: Promise<MountainRecord[]> | null = null;

function load(): Promise<MountainRecord[]> {
  if (cache) return Promise.resolve(cache);
  if (loading) return loading;
  // base 配下に解決させる（GitHub Pages のプロジェクトページでも正しく引ける）。
  const url = `${import.meta.env.BASE_URL}data/mountains.json`;
  loading = fetch(url)
    .then((r) => (r.ok ? r.json() : []))
    .then((d: MountainRecord[]) => {
      cache = Array.isArray(d) ? d : [];
      return cache;
    })
    .catch(() => {
      loading = null;
      return [];
    });
  return loading;
}

// カタカナ→ひらがな（読み検索をカナ種別に依存させない）。
function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** 全山頂を返す（山頂マーカー用）。データは一度ロードしてキャッシュ。 */
export async function loadAllMountains(): Promise<MountainHit[]> {
  const list = await load();
  return list.map((m) => ({
    name: m.name,
    lat: m.latitude,
    lon: m.longitude,
    elevationM: m.elevation_m,
    prefecture: m.prefecture,
  }));
}

/** 名前・読みで部分一致。重要度(priority)→標高の順で並べ、上位 limit 件を返す。 */
export async function searchMountains(query: string, limit = 12): Promise<MountainHit[]> {
  const list = await load();
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qh = toHiragana(q);
  const hits = list.filter((m) => {
    if (m.name.toLowerCase().includes(q)) return true;
    return m.name_kana ? toHiragana(m.name_kana).includes(qh) : false;
  });
  hits.sort((a, b) => b.priority - a.priority || b.elevation_m - a.elevation_m);
  return hits.slice(0, limit).map((m) => ({
    name: m.name,
    lat: m.latitude,
    lon: m.longitude,
    elevationM: m.elevation_m,
    prefecture: m.prefecture,
  }));
}
