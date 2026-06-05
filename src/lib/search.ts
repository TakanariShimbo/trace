// 検索のとりまとめ。モードに応じて「山名（mountains.json）」「土地名（GSI地名検索）」
// またはその両方を引き、共通の SearchResult 配列にして返す。

import { searchPlaces } from "./geocode";
import { searchMountains } from "./mountains";

export type SearchKind = "mountain" | "place";
export type SearchMode = "mountain" | "place" | "both";

export type SearchResult = {
  title: string;
  lat: number;
  lon: number;
  kind: SearchKind;
  sub?: string; // 都道府県など補助表示
  elevationM?: number; // 山のとき標高
};

/** モードに応じて検索。両方の場合は山→土地名の順でマージし、上位 limit 件。 */
export async function runSearch(
  query: string,
  mode: SearchMode,
  limit = 12,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const [mountains, places] = await Promise.all([
    mode !== "place" ? searchMountains(q, limit) : Promise.resolve([]),
    mode !== "mountain" ? searchPlaces(q, limit) : Promise.resolve([]),
  ]);

  const out: SearchResult[] = [];
  for (const m of mountains) {
    out.push({ title: m.name, lat: m.lat, lon: m.lon, kind: "mountain", sub: m.prefecture, elevationM: m.elevationM });
  }
  for (const p of places) {
    out.push({ title: p.title, lat: p.lat, lon: p.lon, kind: "place" });
  }
  return out.slice(0, limit);
}
