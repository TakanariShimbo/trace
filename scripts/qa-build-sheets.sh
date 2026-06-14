#!/bin/bash
# サムネ品質チェック用のコンタクトシートを作る。
# 各サムネに「#id 標高m」を焼き込み（不良の指摘を id で返せるように）、
# 20枚(5x4)ずつタイル化して /tmp/qa/sheets/sheet_NNN.png を出力する。
# 並び順は表示順（priority降順→標高降順）。生成済みのものだけ対象。
set -u
cd /home/ai-workshop/work/sangaku
QA=/tmp/qa
rm -rf "$QA"; mkdir -p "$QA/labeled" "$QA/sheets"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

# 表示順に並べ、生成済みサムネだけを index→id で書き出す。
node -e '
const m=require("./public/data/mountains.json");
const fs=require("fs");
m.sort((a,b)=>b.priority-a.priority||b.elevation_m-a.elevation_m);
const rows=[];
let i=0;
for(const x of m){
  if(fs.existsSync(`public/thumbs/${x.id}.webp`)){
    rows.push([String(i).padStart(4,"0"), x.id, x.elevation_m, x.name].join("\t"));
    i++;
  }
}
fs.writeFileSync("/tmp/qa/order.tsv", rows.join("\n"));
console.log(rows.length+" thumbs");
'

# 各サムネをラベル付き 288x162 PNG に（並列でラベル焼き込み）。
label_one() {
  local seq="$1" id="$2" elev="$3"
  ffmpeg -y -loglevel error -i "public/thumbs/$id.webp" \
    -vf "scale=288:162,drawtext=fontfile=$FONT:text='#$id  ${elev}m':x=6:y=6:fontsize=16:fontcolor=0xFFD24A:box=1:boxcolor=black@0.65:boxborderw=4" \
    "/tmp/qa/labeled/$seq.png"
}
export -f label_one
export FONT
awk -F'\t' '{print $1"\t"$2"\t"$3}' /tmp/qa/order.tsv | \
  xargs -P 8 -I{} bash -c 'IFS=$'"'"'\t'"'"' read -r s i e <<< "{}"; label_one "$s" "$i" "$e"'

# 5x4=20枚ずつのコンタクトシートにタイル化。
ffmpeg -y -loglevel error -framerate 1 -i "$QA/labeled/%04d.png" \
  -vf "tile=5x4:padding=6:margin=6:color=0x0c0d10" "$QA/sheets/sheet_%03d.png"

echo "labeled=$(ls "$QA/labeled" | wc -l)  sheets=$(ls "$QA/sheets" | wc -l)"
