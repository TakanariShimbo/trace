#!/bin/bash
# サムネ生成の見張り役。gen-thumbs.mjs を回し続け、数分間1枚も進まない／genが落ちたら
# ブラウザを立ち上げ直して再開する。public/thumbs が目標数に達したら終了。再開可能なので安全。
set -u
cd /home/ai-workshop/work/sangaku
TH=public/thumbs
LOG=/tmp/gen-thumbs.log
URL="http://localhost:5173/#/__thumbs"
TARGET=1061

count() { ls "$TH"/*.webp 2>/dev/null | wc -l; }

restart_browser() {
  echo "[sup $(date -u +%H:%M:%S)] restarting browser" >> "$LOG"
  npx --no-install playwright-cli close-all >/dev/null 2>&1
  sleep 2
  npx --no-install playwright-cli open "$URL" >/dev/null 2>&1
  npx --no-install playwright-cli reload >/dev/null 2>&1
  # __thumbReady になるまで最大30秒待つ
  for _ in $(seq 1 15); do
    r=$(npx --no-install playwright-cli --raw eval "String(window.__thumbReady)" 2>/dev/null | tr -d '"')
    [ "$r" = "true" ] && break
    sleep 2
  done
  echo "[sup $(date -u +%H:%M:%S)] browser ready=$r" >> "$LOG"
}

start_gen() {
  node scripts/gen-thumbs.mjs 8 >> "$LOG" 2>&1 &
  GENPID=$!
  GENSTART=$(count)
}

kill_gen() {
  kill "$GENPID" 2>/dev/null
  pkill -f "playwright-cli --raw eval" 2>/dev/null
  sleep 2
}

start_gen
prev=$(count)
stall=0
deadpass=0

while true; do
  sleep 60
  total=$(count)

  if [ "$total" -ge "$TARGET" ]; then
    echo "[sup $(date -u +%H:%M:%S)] target reached: $total" >> "$LOG"
    kill_gen
    break
  fi

  # gen が終了している（todo を処理し切った or 落ちた）
  if ! kill -0 "$GENPID" 2>/dev/null; then
    if [ "$total" -le "$GENSTART" ]; then
      deadpass=$((deadpass+1))
    else
      deadpass=0
    fi
    if [ "$deadpass" -ge 2 ]; then
      echo "[sup $(date -u +%H:%M:%S)] no progress across full passes; giving up at $total" >> "$LOG"
      break
    fi
    echo "[sup $(date -u +%H:%M:%S)] gen exited at $total; refresh+restart" >> "$LOG"
    restart_browser
    start_gen
    prev=$total
    stall=0
    continue
  fi

  # 進捗チェック（60秒ごと、4回連続=約4分 進まなければストール扱い）
  if [ "$total" -le "$prev" ]; then
    stall=$((stall+1))
  else
    stall=0
    prev=$total
  fi
  if [ "$stall" -ge 4 ]; then
    echo "[sup $(date -u +%H:%M:%S)] stall at $total; kicking browser+gen" >> "$LOG"
    kill_gen
    restart_browser
    start_gen
    prev=$total
    stall=0
  fi
done
echo "[sup $(date -u +%H:%M:%S)] supervisor done: $(count) files" >> "$LOG"
