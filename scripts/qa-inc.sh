#!/bin/bash
# 増分QA: 前回チェック以降に生成された新規サムネだけをラベル付き→コンタクトシート化する。
# マーカー /tmp/qa/.last_qa より新しい webp が対象（無ければ全件）。出力は /tmp/qa/inc/sheets/。
# 標準出力の最終行: "INC_READY n=<新規枚数> sheets=<シート数>" または "INC_NONE"。
set -u
cd /home/ai-workshop/work/sangaku
QA=/tmp/qa
INC=$QA/inc
MARK=$QA/.last_qa
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
rm -rf "$INC"; mkdir -p "$INC/labeled" "$INC/sheets"

# 新規 webp を列挙（マーカーより新しいもの。無ければ全件）。
if [ -f "$MARK" ]; then
  mapfile -t FILES < <(find public/thumbs -name '*.webp' -newer "$MARK" 2>/dev/null)
else
  mapfile -t FILES < <(find public/thumbs -name '*.webp' 2>/dev/null)
fi
if [ "${#FILES[@]}" -eq 0 ]; then echo "INC_NONE"; exit 0; fi

# node で 表示順(priority降→標高降)に並べ、seq・id・標高・パス を出力。
printf '%s\n' "${FILES[@]}" | node -e '
const fs=require("fs");
const m=require("./public/data/mountains.json");
const meta={};for(const x of m)meta[x.id]={el:x.elevation_m,pr:x.priority};
const paths=fs.readFileSync(0,"utf8").trim().split("\n").filter(Boolean);
const rows=paths.map(p=>{const id=Number(p.split("/").pop().replace(".webp",""));const mm=meta[id]||{el:0,pr:0};return {id,p,el:mm.el,pr:mm.pr};});
rows.sort((a,b)=>b.pr-a.pr||b.el-a.el);
const out=rows.map((r,i)=>[String(i).padStart(4,"0"),r.id,r.el,r.p].join("\t"));
fs.writeFileSync("/tmp/qa/inc/list.tsv",out.join("\n"));
' || { echo "INC_ERR node"; exit 1; }

# ラベル焼き込み（並列）。
label_one(){ ffmpeg -y -loglevel error -i "$4" -vf "scale=288:162,drawtext=fontfile=$FONT:text='#$2  $3m':x=6:y=6:fontsize=16:fontcolor=0xFFD24A:box=1:boxcolor=black@0.65:boxborderw=4" "/tmp/qa/inc/labeled/$1.png"; }
export -f label_one; export FONT
xargs -P 8 -a "$INC/list.tsv" -d '\n' -I{} bash -c 'IFS=$'"'"'\t'"'"' read -r s i e f <<<"{}"; label_one "$s" "$i" "$e" "$f"'

# 5x4=20枚ずつのシートにタイル化。
ffmpeg -y -loglevel error -framerate 1 -i "$INC/labeled/%04d.png" \
  -vf "tile=5x4:padding=6:margin=6:color=0x0c0d10" "$INC/sheets/sheet_%03d.png"

touch "$MARK"
echo "INC_READY n=${#FILES[@]} sheets=$(ls "$INC/sheets" 2>/dev/null | wc -l)"
