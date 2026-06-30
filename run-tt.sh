#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────
# run-tt.sh — รันบอท TT^ : เปิด ngrok อัตโนมัติ แล้วต่อด้วย hermes gateway
# ใช้: ./run-tt.sh   (รันทีเดียวได้ทั้ง tunnel + gateway)
# ───────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="familybot.ngrok.app"
PORT="8646"
PROJECT_DIR="$HOME/my-projects/family-bot"
HERMES="$PROJECT_DIR/.venv/bin/hermes"
NGROK_LOG="/tmp/ngrok-tt.log"

cd "$PROJECT_DIR"

STARTED_NGROK=0

cleanup() {
  # ถ้า script นี้เป็นคนเปิด ngrok เอง ก็ปิดตอนจบ (กด Ctrl-C ที่ gateway)
  if [ "$STARTED_NGROK" = "1" ] && [ -n "${NGROK_PID:-}" ]; then
    echo "🛑 ปิด ngrok (pid $NGROK_PID)…"
    kill "$NGROK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 1) ngrok — ถ้ายังไม่รันอยู่ ค่อยเปิดใหม่
if pgrep -f "ngrok .*${DOMAIN}" >/dev/null 2>&1 || pgrep -f "ngrok http .*${PORT}" >/dev/null 2>&1; then
  echo "✓ ngrok กำลังรันอยู่แล้ว — ใช้ tunnel เดิม"
else
  echo "🚀 เปิด ngrok → https://${DOMAIN}  (→ 127.0.0.1:${PORT})"
  ngrok http "--domain=${DOMAIN}" "$PORT" --log=stdout > "$NGROK_LOG" 2>&1 &
  NGROK_PID=$!
  STARTED_NGROK=1

  # รอจน tunnel ขึ้น — อ่านจาก ngrok log ตรงๆ (แม่นกว่า :4040 ที่ชนกันเมื่อมี ngrok หลายตัว)
  echo -n "⏳ รอ tunnel พร้อม"
  for i in $(seq 1 30); do
    if grep -q "started tunnel" "$NGROK_LOG" 2>/dev/null; then
      echo " — พร้อม! ✓"
      break
    fi
    # จับ error เช่น domain ซ้ำ / authtoken ผิด แล้วออกทันที
    if grep -qiE "ERR_NGROK|command failed|lvl=eror|authentication failed" "$NGROK_LOG" 2>/dev/null; then
      echo ""; echo "❌ ngrok error — ดู log: $NGROK_LOG"; tail -20 "$NGROK_LOG"; exit 1
    fi
    if ! kill -0 "$NGROK_PID" 2>/dev/null; then
      echo ""; echo "❌ ngrok ดับ — ดู log: $NGROK_LOG"; tail -20 "$NGROK_LOG"; exit 1
    fi
    echo -n "."; sleep 1
  done
fi

echo ""
echo "🔗 Webhook URL (ใส่ใน LINE Console): https://${DOMAIN}/line/webhook"
echo "❤️  Health: https://${DOMAIN}/line/webhook/health"
echo "─────────────────────────────────────────────"
echo "💚 เริ่ม TT^ gateway… (กด Ctrl-C เพื่อหยุด)"
echo ""

# 2) gateway (foreground)
exec "$HERMES" gateway
