// 山の図鑑。全1,061座を検索・フィルタ・ソートで一覧し、個別ページでは
// 写真の代わりに3D地形の自動周回ビュー＋解説で山を知る。
import { useEffect, useMemo, useRef, useState } from "react";
import { IconHome, IconChevron, IconSearch, IconMountain, IconSun, IconLink } from "./icons";
import { loadZukanEntries, type ZukanEntry } from "../lib/mountains";
import ZukanOrbit from "./ZukanOrbit";

type Props = {
  onHome: () => void;
  // この山を中心にシミュレーションへ（terrain=地形のみ / celestial=太陽・月あり）。
  onOpenMap: (mode: "terrain" | "celestial", target: { lat: number; lon: number }) => void;
};

// 並び順。famous=有名順(priority)、elevDesc/Asc=標高、kana=五十音。
type SortKey = "famous" | "elevDesc" | "elevAsc" | "kana";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "famous", label: "有名順" },
  { key: "elevDesc", label: "標高（高い順）" },
  { key: "elevAsc", label: "標高（低い順）" },
  { key: "kana", label: "五十音順" },
];

// 標高帯フィルタ。
const ELEV_BANDS: { key: string; label: string; min: number; max: number }[] = [
  { key: "all", label: "すべての標高", min: 0, max: Infinity },
  { key: "3000", label: "3000m以上", min: 3000, max: Infinity },
  { key: "2000", label: "2000〜2999m", min: 2000, max: 3000 },
  { key: "1000", label: "1000〜1999m", min: 1000, max: 2000 },
  { key: "low", label: "1000m未満", min: 0, max: 1000 },
];

// 都道府県の標準順（北→南）。データに現れたものだけセレクトに出す。
const PREF_ORDER = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
  "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
  "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
  "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

const PAGE = 60; // 一覧の段階表示の単位（全件即レンダーを避ける）

// 共有リンク（#/zukan?q=..&pref=.. / #/zukan/123）から検索状態・山IDを復元する。
function parseZukanHash() {
  const [path, query] = location.hash.replace(/^#\/?/, "").split("?");
  const segs = path.split("/");
  const p = new URLSearchParams(query);
  const id = segs[0] === "zukan" && segs[1] ? Number(segs[1]) : null;
  return {
    id: Number.isFinite(id as number) ? id : null,
    q: p.get("q") ?? "",
    pref: p.get("pref") ?? "all",
    elev: ELEV_BANDS.some((b) => b.key === p.get("elev")) ? (p.get("elev") as string) : "all",
    tag: p.get("tag") ?? "all",
    sort: SORTS.some((s) => s.key === p.get("sort")) ? (p.get("sort") as SortKey) : ("famous" as SortKey),
  };
}

export default function Zukan({ onHome, onOpenMap }: Props) {
  // 初期状態は共有リンク（URLハッシュ）から復元。
  const [init] = useState(parseZukanHash);
  const [entries, setEntries] = useState<ZukanEntry[] | null>(null);
  const [q, setQ] = useState(init.q);
  const [pref, setPref] = useState(init.pref);
  const [elevBand, setElevBand] = useState(init.elev);
  const [tag, setTag] = useState(init.tag);
  const [sort, setSort] = useState<SortKey>(init.sort);
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<ZukanEntry | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(init.id); // データ到着後に開く山ID
  const [copied, setCopied] = useState(false); // 「リンクをコピー」の完了表示
  const listScrollRef = useRef(0); // 詳細から戻った時にスクロール位置を復元
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    loadZukanEntries().then((list) => alive && setEntries(list));
    return () => {
      alive = false;
    };
  }, []);

  // データに現れる都道府県（"山梨県/静岡県" は分割）を標準順で。
  const prefs = useMemo(() => {
    if (!entries) return [];
    const present = new Set<string>();
    for (const e of entries) for (const p of (e.prefecture ?? "").split("/")) if (p) present.add(p.trim());
    return PREF_ORDER.filter((p) => present.has(p));
  }, [entries]);

  // タグ（出現数の多い順に上位を出す）。
  const tags = useMemo(() => {
    if (!entries) return [];
    const count = new Map<string, number>();
    for (const e of entries) for (const t of e.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t);
  }, [entries]);

  // 検索＋フィルタ＋ソートの結果。
  const filtered = useMemo(() => {
    if (!entries) return [];
    const band = ELEV_BANDS.find((b) => b.key === elevBand) ?? ELEV_BANDS[0];
    const query = q.trim().toLowerCase();
    const list = entries.filter((e) => {
      if (e.elevationM < band.min || e.elevationM >= band.max) return false;
      if (pref !== "all" && !(e.prefecture ?? "").split("/").some((p) => p.trim() === pref)) return false;
      if (tag !== "all" && !e.tags.includes(tag)) return false;
      if (query && !e.name.toLowerCase().includes(query) && !(e.kana ?? "").includes(query)) return false;
      return true;
    });
    const by: Record<SortKey, (a: ZukanEntry, b: ZukanEntry) => number> = {
      famous: (a, b) => b.priority - a.priority || b.elevationM - a.elevationM,
      elevDesc: (a, b) => b.elevationM - a.elevationM,
      elevAsc: (a, b) => a.elevationM - b.elevationM,
      kana: (a, b) => (a.kana ?? a.name).localeCompare(b.kana ?? b.name, "ja"),
    };
    return list.sort(by[sort]);
  }, [entries, q, pref, elevBand, tag, sort]);

  // 条件が変わったら表示件数をリセット。
  useEffect(() => setShown(PAGE), [q, pref, elevBand, tag, sort]);

  // 共有リンクで個別ページ指定（#/zukan/123）→ データ到着後にその山を開く。
  useEffect(() => {
    if (!entries || pendingId == null) return;
    const e = entries.find((m) => m.id === pendingId);
    if (e) setSelected(e);
    setPendingId(null);
  }, [entries, pendingId]);

  // 現在の状態（個別ページ or 検索条件）をURLハッシュへ反映 → そのままコピーで共有できる。
  useEffect(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (pref !== "all") sp.set("pref", pref);
    if (elevBand !== "all") sp.set("elev", elevBand);
    if (tag !== "all") sp.set("tag", tag);
    if (sort !== "famous") sp.set("sort", sort);
    const qs = sp.toString();
    const hash = selected ? `#/zukan/${selected.id}` : `#/zukan${qs ? `?${qs}` : ""}`;
    history.replaceState(null, "", location.pathname + location.search + hash);
  }, [q, pref, elevBand, tag, sort, selected]);

  // 現在のURLをクリップボードへ（共有リンク）。1.6秒だけ「コピーしました」を出す。
  const copyTimerRef = useRef(0);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // クリップボード不可（権限など）の場合はプロンプトで提示。
      window.prompt("このリンクをコピーしてください", location.href);
    }
  };

  const openDetail = (e: ZukanEntry) => {
    listScrollRef.current = rootRef.current?.scrollTop ?? 0;
    setSelected(e);
    rootRef.current?.scrollTo({ top: 0 });
  };
  const backToList = () => {
    setSelected(null);
    // 一覧の再マウント後にスクロール位置を戻す。
    requestAnimationFrame(() => rootRef.current?.scrollTo({ top: listScrollRef.current }));
  };

  return (
    <div className="home zukan" ref={rootRef}>
      {/* 共有リンクのコピー（右上・ホームの左隣。詳細＝この山 / 一覧＝検索結果へのリンク）。 */}
      <button
        className="zukan-share"
        title={selected ? "この山へのリンクをコピー" : "この検索結果へのリンクをコピー"}
        onClick={copyLink}
      >
        <IconLink size={15} /> {copied ? "コピーしました ✓" : "リンクをコピー"}
      </button>
      <button className="home-btn" title="ホーム画面へ戻る" aria-label="ホーム" onClick={onHome}>
        <IconHome size={18} />
      </button>

      {selected ? (
        /* ====== 個別詳細ページ ====== */
        <div className="zukan-inner">
          <button className="zukan-back" onClick={backToList}>
            <IconChevron dir="left" size={16} /> 図鑑にもどる
          </button>
          {/* 写真の代わり: 3D地形の自動周回ビュー */}
          <ZukanOrbit lat={selected.lat} lon={selected.lon} elevationM={selected.elevationM} />
          <header className="zukan-detail-head">
            <h1>{selected.name}</h1>
            <p className="zukan-detail-sub">
              {selected.kana && <span>{selected.kana}</span>}
              {selected.titleEn && <span>{selected.titleEn}</span>}
            </p>
          </header>
          <div className="zukan-detail-facts">
            <span className="zukan-fact">
              <b>{selected.elevationM.toLocaleString()}</b> m
            </span>
            {selected.prefecture && <span className="zukan-fact">{selected.prefecture.replace(/\//g, "・")}</span>}
            <span className="zukan-fact zukan-fact--dim">
              {selected.lat.toFixed(4)}, {selected.lon.toFixed(4)}
            </span>
          </div>
          {selected.tags.length > 0 && (
            <div className="zukan-tags">
              {selected.tags.map((t) => (
                <button
                  key={t}
                  className="zukan-tag"
                  title={`タグ「${t}」で一覧を絞り込む`}
                  onClick={() => {
                    setTag(t);
                    backToList();
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {selected.descriptionJa && <p className="zukan-desc">{selected.descriptionJa}</p>}
          {selected.descriptionEn && <p className="zukan-desc zukan-desc--en">{selected.descriptionEn}</p>}
          {/* この山を中心にシミュレーションへ（地形のみ / 太陽・月あり）。読み終わりの導線として解説の下。 */}
          <div className="zukan-actions">
            <button
              className="zukan-action"
              onClick={() => onOpenMap("terrain", { lat: selected.lat, lon: selected.lon })}
            >
              <IconMountain size={15} /> この山の地形を見る
            </button>
            <button
              className="zukan-action"
              onClick={() => onOpenMap("celestial", { lat: selected.lat, lon: selected.lon })}
            >
              <IconSun size={15} /> 太陽・月の動きと見る
            </button>
          </div>
          {selected.url && (
            <p className="zukan-src">
              出典・参考:{" "}
              <a href={selected.url} target="_blank" rel="noreferrer">
                {selected.url}
              </a>
            </p>
          )}
        </div>
      ) : (
        /* ====== 一覧ページ ====== */
        <div className="zukan-inner">
          <header className="home-head">
            <h1>山の図鑑</h1>
            <p>日本の山 {entries ? entries.length.toLocaleString() : "…"} 座 ― 検索・絞り込みで、つぎに撮りたい山を見つける</p>
          </header>

          {/* 検索＋フィルタ＋ソート */}
          <div className="zukan-controls">
            <label className="zukan-search">
              <IconSearch size={15} />
              <input
                type="search"
                placeholder="山名・読みで検索"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="山名・読みで検索"
              />
            </label>
            <div className="zukan-filters">
              <select value={pref} onChange={(e) => setPref(e.target.value)} aria-label="都道府県で絞り込み">
                <option value="all">すべての地域</option>
                {prefs.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <select value={elevBand} onChange={(e) => setElevBand(e.target.value)} aria-label="標高で絞り込み">
                {ELEV_BANDS.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.label}
                  </option>
                ))}
              </select>
              <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="タグで絞り込み">
                <option value="all">すべてのタグ</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="並び順">
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="zukan-count">{entries ? `${filtered.length.toLocaleString()} 座` : "読み込み中…"}</p>
          </div>

          {/* カード一覧（段階表示） */}
          <div className="zukan-grid">
            {filtered.slice(0, shown).map((e) => (
              <button key={e.id} className="zukan-card" onClick={() => openDetail(e)}>
                <span className="zukan-card-head">
                  <span className="zukan-card-name">{e.name}</span>
                  <span className="zukan-card-elev">{e.elevationM.toLocaleString()}m</span>
                </span>
                <span className="zukan-card-sub">
                  {e.kana && <span>{e.kana}</span>}
                  {e.prefecture && <span>{e.prefecture.replace(/\//g, "・")}</span>}
                </span>
                {e.descriptionShortJa && <span className="zukan-card-desc">{e.descriptionShortJa}</span>}
                {e.tags.length > 0 && (
                  <span className="zukan-card-tags">
                    {e.tags.slice(0, 3).map((t) => (
                      <span key={t} className="zukan-tag zukan-tag--mini">
                        {t}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
          {entries && filtered.length === 0 && (
            <p className="zukan-empty">
              <IconMountain size={18} /> 条件に合う山がありません。絞り込みをゆるめてみてください。
            </p>
          )}
          {filtered.length > shown && (
            <button className="zukan-more" onClick={() => setShown((n) => n + PAGE * 2)}>
              さらに表示（残り {(filtered.length - shown).toLocaleString()} 座）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
