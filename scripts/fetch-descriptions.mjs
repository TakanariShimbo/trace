// 山DBの各山にWikipedia(日本語)のイントロ解説を付与するための取得スクリプト。
//   出典: Wikipedia 日本語版（テキストは CC BY-SA 4.0）。各記事URLを保存し、UIで出典を明記する。
//
// 使い方:
//   node scripts/fetch-descriptions.mjs --sample 80   # サンプルだけ（精度確認用、保存しない）
//   node scripts/fetch-descriptions.mjs               # 全件取得し public/data/mountain_descriptions.json に保存
//
// マッチング方針（同名の山を取り違えないため座標＋山らしさで照合）:
//   A) 名前（括弧除去）を一括バッチ取得し、記事座標が山頂座標の近く&「山らしい」記事なら採用
//   B) 未解決は 別名(括弧内) と list=search の候補から、座標が最も近い山記事を採用
//   曖昧さ回避ページ・座標なし・遠すぎ・市/湖など非山記事は不採用（解説なし＝従来表示のまま）
import fs from "node:fs";

const API = "https://ja.wikipedia.org/w/api.php";
const UA = "SangakuBot/0.1 (https://github.com/TakanariShimbo/sangaku; mountain descriptions)";
const DEG_TOL = 0.2; // 山頂座標と記事座標の許容差（度）。同名異山の判別に十分かつ座標源の差を許容。
const EXTRACT_MAX = 300; // 解説の最大文字数（文末。で丸める）
const SLEEP_MS = 250; // API礼儀のための待機

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params) {
  const u = new URL(API);
  u.search = new URLSearchParams({ format: "json", formatversion: "2", ...params }).toString();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA } });
      if (r.ok) return await r.json();
    } catch {
      /* リトライ */
    }
    await sleep(600 * (attempt + 1));
  }
  return null;
}

const near = (a1, o1, a2, o2) => Math.abs(a1 - a2) <= DEG_TOL && Math.abs(o1 - o2) <= DEG_TOL;
const dist = (a1, o1, a2, o2) => Math.hypot(a1 - a2, o1 - o2);
const stripParen = (s) => s.replace(/[（(].*?[)）]/g, "").trim();
const parenAlt = (s) => (s.match(/[（(](.+?)[)）]/)?.[1] || "").trim();

function trimExtract(s) {
  if (!s) return "";
  let t = s.replace(/\s+/g, " ").trim();
  if (t.length <= EXTRACT_MAX) return t;
  t = t.slice(0, EXTRACT_MAX);
  const last = t.lastIndexOf("。");
  return last > EXTRACT_MAX * 0.5 ? t.slice(0, last + 1) : t + "…";
}

// 抜粋の先頭文で「山らしさ」を判定（カテゴリは件数が多く応答が継続打ち切りになるため使わない）。
//   山: 「…の山。」「標高…」「…岳（…）は」等 / 除外: 駅・市・川・神社・曖昧さ回避 など
const firstSentence = (ex) => { const t = (ex || "").replace(/\s+/g, " ").trim(); const i = t.indexOf("。"); return i < 0 ? t : t.slice(0, i + 1); };
function isMountainText(ex) {
  const s = firstSentence(ex);
  if (!s) return false;
  if (/(以下|曖昧さ回避|を指す|に関する記事|の名称|の名前)/.test(s)) return false; // 曖昧さ回避ページ（「山の名称」等）
  if (/(駅|市|町|村|区|湖|沼|池|川|河川|温泉|神社|寺院?|城|公園|空港|鉄道|道路|トンネル|ダム|峠|学校|大学|株式会社)。?$/.test(s)) return false;
  return /(山|岳|峰|嶽|連峰|火山|標高|山頂|高原|山地)/.test(s);
}

// タイトル群をまとめて取得（extracts は exlimit 上限20なので20件ずつ）。元候補名→ページの対応を返す。
async function fetchPages(titles) {
  const out = {};
  const uniq = [...new Set(titles)];
  for (let i = 0; i < uniq.length; i += 20) {
    const chunk = uniq.slice(i, i + 20);
    const j = await api({
      action: "query",
      prop: "extracts|coordinates",
      exintro: "1",
      explaintext: "1",
      exlimit: "max",
      colimit: "max",
      redirects: "1",
      titles: chunk.join("|"),
    });
    await sleep(SLEEP_MS);
    const alias = {};
    for (const n of j?.query?.normalized || []) alias[n.from] = n.to;
    for (const r of j?.query?.redirects || []) alias[r.from] = r.to;
    const resolve = (t) => { let x = t, seen = new Set(); while (alias[x] && !seen.has(x)) { seen.add(x); x = alias[x]; } return x; };
    const byTitle = {};
    for (const p of j?.query?.pages || []) byTitle[p.title] = p;
    for (const t of chunk) out[t] = byTitle[resolve(t)] || { missing: true };
  }
  return out;
}

async function searchCandidates(name) {
  const j = await api({ action: "query", list: "search", srsearch: name, srlimit: "10", srnamespace: "0" });
  await sleep(SLEEP_MS);
  return (j?.query?.search || []).map((s) => s.title);
}

// 山記事を選ぶ。座標があれば近さで判定し、最寄りを採用。
//   requireCoord=false（名前完全一致パス）では、座標が無い山記事（例: 富士山は座標がWikidata側）も採用可。
function chooseMountain(mt, pages, requireCoord) {
  let best = null;
  let coordless = null;
  for (const p of Object.values(pages)) {
    if (!p || p.missing || !isMountainText(p.extract)) continue;
    const c = p.coordinates?.[0];
    if (c) {
      if (!near(mt.latitude, mt.longitude, c.lat, c.lon)) continue; // 同名異山は座標で除外
      const d = dist(mt.latitude, mt.longitude, c.lat, c.lon);
      if (!best || d < best.d) best = { page: p, d };
    } else if (!requireCoord && !coordless) {
      coordless = { page: p, d: 9 }; // 座標なしは座標一致を優先しつつ保険で確保
    }
  }
  return best || coordless;
}

function mkResult(mt, best, via) {
  const p = best.page;
  const extract = trimExtract(p.extract);
  if (!extract || extract.length < 20) return null;
  return {
    title: p.title,
    extract,
    url: "https://ja.wikipedia.org/wiki/" + encodeURIComponent(p.title.replace(/ /g, "_")),
    via,
    distDeg: Number(best.d.toFixed(4)),
  };
}

// --- main ---
const args = process.argv.slice(2);
const sampleIdx = args.indexOf("--sample");
const all = JSON.parse(fs.readFileSync("public/data/mountains.json", "utf8"));
let targets = all;
if (sampleIdx >= 0) {
  const n = Number(args[sampleIdx + 1]) || 80;
  const step = Math.max(1, Math.floor(all.length / n));
  targets = all.filter((_, i) => i % step === 0).slice(0, n);
}

const results = {};
const unresolved = [];

// Phase A: 名前（括弧除去）を全件まとめて取得して座標一致を採用
process.stderr.write("Phase A: 名前一括取得…\n");
const primaryPages = await fetchPages(targets.map((m) => stripParen(m.name)));
for (const mt of targets) {
  const p = primaryPages[stripParen(mt.name)];
  const best = p && !p.missing ? chooseMountain(mt, { p }, false) : null;
  if (best) { const r = mkResult(mt, best, "name"); if (r) { results[mt.id] = r; continue; } }
  unresolved.push(mt);
}
process.stderr.write(`Phase A 完了: hit=${Object.keys(results).length} 未解決=${unresolved.length}\n`);

// Phase B: 別名＋検索フォールバック（未解決のみ、個別に）
process.stderr.write("Phase B: 別名/検索フォールバック…\n");
const misses = [];
for (let i = 0; i < unresolved.length; i++) {
  const mt = unresolved[i];
  const cand = [];
  const alt = parenAlt(mt.name);
  if (alt) cand.push(alt);
  cand.push(...(await searchCandidates(stripParen(mt.name))));
  const pages = cand.length ? await fetchPages(cand) : {};
  const best = chooseMountain(mt, pages, true);
  if (best) { const r = mkResult(mt, best, "search"); if (r) { results[mt.id] = r; } else misses.push(mt.name); }
  else misses.push(mt.name);
  if ((i + 1) % 20 === 0 || i === unresolved.length - 1)
    process.stderr.write(`\r  ${i + 1}/${unresolved.length}`);
}
process.stderr.write("\n");

const ok = Object.keys(results).length;
console.log("対象:", targets.length, " ヒット:", ok, `(${((ok / targets.length) * 100).toFixed(0)}%)`, " 欠落:", misses.length);
console.log("内訳: 直接一致", Object.values(results).filter((r) => r.via === "name").length,
  " 検索", Object.values(results).filter((r) => r.via === "search").length);
console.log("欠落例:", misses.slice(0, 25).join(", "));

if (sampleIdx < 0) {
  const payload = {
    _meta: {
      source: "Wikipedia 日本語版",
      license: "CC BY-SA 4.0",
      note: "各 extract は記事冒頭の抜粋。url は出典記事。",
      generated: new Date().toISOString(),
      count: ok,
    },
    descriptions: results,
  };
  fs.writeFileSync("public/data/mountain_descriptions.json", JSON.stringify(payload));
  console.log("保存: public/data/mountain_descriptions.json (", ok, "件 )");
} else {
  for (const [id, r] of Object.entries(results).slice(0, 5)) {
    const mt = all.find((m) => String(m.id) === id);
    console.log(`\n■ ${mt?.name} → ${r.title} (via ${r.via}, d=${r.distDeg})`);
    console.log("  ", r.extract);
  }
}
