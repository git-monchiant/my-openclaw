# Deploy "ตูดตึง" ไป Mac Studio (รัน 24 ชม.)

**โมเดล:** MacBook = เครื่อง dev/เทส · **Mac Studio (`monchiant@192.168.1.100`) = prod รัน 24 ชม.**
รันได้ทีละเครื่องเท่านั้น (ngrok domain `familybot.ngrok.app` + LINE webhook ชี้ได้ที่เดียว).

โค้ดไป Studio ผ่าน **git** · ความลับ+state (`~/.hermes`, ไม่อยู่ใน git) ไป Studio ผ่าน **rsync**.

---

## ครั้งแรก (first-time deploy)

### 1) 🖥️ MacBook — push โค้ด + ปิดบอทเครื่องนี้
```bash
cd ~/my-projects/family-bot
hermes gateway stop            # ปิดก่อน (กัน ngrok domain ชน + sqlite เขียนกลางคัน)
pkill -f "ngrok.*familybot" || true
git push origin main           # โค้ดล่าสุดขึ้น GitHub
```

### 2) 🖥️ MacBook — ส่ง ~/.hermes (ความลับ+state) ไป Studio
```bash
bash deploy/1-sync-hermes.sh   # rsync ~/.hermes → Studio (ทับของเก่า)
```

### 3) 🖥️ Studio (ผ่าน VS Code Remote-SSH / `ssh monchiant@192.168.1.100`)
```bash
cd ~/my-projects/family-bot
git pull origin main
bash deploy/2-studio-setup.sh  # สร้าง venv + ลง deps + ตั้ง launchd + สตาร์ตบอท
```

### 4) 🖥️ Studio — ตั้งค่าเครื่องให้รันจริง 24 ชม. (ทำมือครั้งเดียว, ต้อง sudo/UI)
```bash
sudo pmset -a sleep 0 disksleep 0 autorestart 1    # ไม่หลับ + เปิดเองหลังไฟดับ
```
- System Settings → Users & Groups → เปิด **Automatic login** (เพื่อให้ launchd สตาร์ตเองหลัง reboot)

### 5) ✅ Verify
```bash
curl -s https://familybot.ngrok.app/line/webhook/health   # {"status":"ok",...}
tail -f ~/.hermes/logs/launchd-tt.err.log                 # ดู log บอท
```
แล้วทักในไลน์ดูว่าตอบไหม.

---

## รอบต่อไป (อัปเดตหลังแก้โค้ดบน MacBook)

**แก้โค้ด (`src/`, `scripts/`):**
```bash
# MacBook
git add -A && git commit -m "..." && git push
# Studio
cd ~/my-projects/family-bot && git pull
launchctl kickstart -k "gui/$(id -u)/com.familybot.tt"   # รีสตาร์ตบอท
```

**แก้ config/ความลับ (`~/.hermes/*` เช่น SOUL.md, .env, cron):** ไม่อยู่ใน git → ต้อง rsync
```bash
# MacBook
bash deploy/1-sync-hermes.sh
# Studio (ถ้าแก้ .env/cron ให้รีสตาร์ต; แก้ SOUL.md เฉยๆ ไม่ต้อง — อ่านสดทุกเทิร์น)
launchctl kickstart -k "gui/$(id -u)/com.familybot.tt"
```
> เทสได้บน MacBook โดยไม่ต้องเปิด gateway: รันสคริปต์/tool ตรงๆ เช่น
> `.venv/bin/python scripts/family/classroom_reminder.py`

---

## คำสั่งดูแลบน Studio
```bash
launchctl print "gui/$(id -u)/com.familybot.tt" | head        # สถานะ service
launchctl kickstart -k "gui/$(id -u)/com.familybot.tt"        # รีสตาร์ต
launchctl bootout "gui/$(id -u)/com.familybot.tt"             # หยุด (unload)
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.familybot.tt.plist  # สตาร์ต (load)
```
