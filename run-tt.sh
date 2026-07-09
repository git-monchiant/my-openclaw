#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# run-tt.sh — รันบอท "ตูดตึง" : เปิด ngrok (ตรวจ tunnel จริง) แล้วต่อด้วย hermes gateway
# ใช้: ./run-tt.sh   (หรือให้ launchd เรียกไฟล์นี้เพื่อรัน 24 ชม.)
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="familybot.ngrok.app"
URL="https://${DOMAIN}"
PORT="8646"
PROJECT_DIR="$HOME/my-projects/family-bot"
HERMES="$PROJECT_DIR/.venv/bin/hermes"
NGROK_LOG="/tmp/ngrok-tt.log"
NGROK_API="http://127.0.0.1:4040/api/tunnels"

cd "$PROJECT_DIR"

# tunnel ขึ้นจริงไหม — ถาม ngrok local API ว่ามี public URL ของเราหรือยัง
# (แม่นกว่าการ grep log หรือเช็คแค่ว่ามี process ngrok อยู่)
tunnel_up() {
  curl -s --max-time 3 "$NGROK_API" 2>/dev/null | grep -q "$URL"
}

STARTED_NGROK=0
cleanup() {
  if [ "$STARTED_NGROK" = "1" ] && [ -n "${NGROK_PID:-}" ]; then
    echo "🛑 ปิด ngrok (pid $NGROK_PID)…"
    kill "$NGROK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 1) ngrok — ใช้ tunnel เดิมได้ก็ต่อเมื่อมันยัง "ใช้งานได้จริง" เท่านั้น
if tunnel_up; then
  echo "✓ ngrok tunnel พร้อมอยู่แล้ว — ใช้ต่อ"
else
  # มี process ngrok ค้างแต่ tunnel ไม่พร้อม (เช่น session ชน/ค้างจากรอบก่อน) → ล้างทิ้ง
  # ไม่งั้น ngrok free (1 session) จะเปิดใหม่ไม่ได้
  if pgrep -f "ngrok " >/dev/null 2>&1; then
    echo "⚠️  พบ ngrok ค้าง (tunnel ไม่พร้อม) — ล้างทิ้งก่อนเปิดใหม่"
    pkill -f "ngrok " 2>/dev/null || true
    sleep 2
  fi

  echo "🚀 เปิด ngrok → ${URL}  (→ 127.0.0.1:${PORT})"
  ngrok http "$PORT" "--url=${URL}" --log=stdout > "$NGROK_LOG" 2>&1 &
  NGROK_PID=$!
  STARTED_NGROK=1

  echo -n "⏳ รอ tunnel พร้อม"
  ok=0
  for i in $(seq 1 30); do
    if tunnel_up; then ok=1; echo " — พร้อม! ✓"; break; fi
    # ngrok ตายเอง
    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
      echo ""; echo "❌ ngrok ดับ — ดู log: $NGROK_LOG"; tail -20 "$NGROK_LOG"; exit 1
    fi
    # จับ error ชัดเจน (domain ซ้ำ / authtoken ผิด / session เกินโควตา) แล้วออกทันที
    if grep -qiE "ERR_NGROK|lvl=eror|authentication failed|account is limited|simultaneous" "$NGROK_LOG" 2>/dev/null; then
      echo ""; echo "❌ ngrok error — ดู log: $NGROK_LOG"; tail -20 "$NGROK_LOG"; exit 1
    fi
    echo -n "."; sleep 1
  done
  if [ "$ok" != "1" ]; then
    echo ""; echo "❌ tunnel ไม่ขึ้นใน 30 วิ — ดู log: $NGROK_LOG"; tail -20 "$NGROK_LOG"; exit 1
  fi
fi

echo ""
echo "🔗 Webhook URL (ใส่ใน LINE Console): ${URL}/line/webhook"
echo "❤️  Health: ${URL}/line/webhook/health"
echo "─────────────────────────────────────────────"
echo "💚 เริ่ม gateway… (กด Ctrl-C เพื่อหยุด)"
echo ""

# 2) gateway (foreground) — ถ้าตาย launchd (KeepAlive) จะรีสตาร์ตไฟล์นี้ใหม่
#    รอบใหม่ tunnel_up จะเป็นจริง เลยใช้ ngrok เดิมต่อ ไม่เปิดซ้ำ
exec "$HERMES" gateway
