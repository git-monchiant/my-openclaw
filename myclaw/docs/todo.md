# Todo

## Completed
- [x] ใส่ credentials จริง (.env) แล้วทดสอบกับ LINE จริง ✅
- [x] ทดสอบ do-until loop ว่า AI เรียก tool ได้จริง ✅ (Gemini, Ollama, Anthropic)
- [x] ทดสอบ memory system (บันทึก + ค้นหา) ✅ hybrid search (vector + keyword)
- [x] เพิ่ม tool: web_search ✅ (Gemini, Brave, Perplexity, Grok)
- [x] เพิ่ม tool: http_request ✅ (web-fetch: GET/POST/PUT/DELETE/PATCH/HEAD)
- [x] เพิ่ม memory system (vector search) ✅
- [x] รองรับรูปภาพจาก LINE ✅ multimodal (image/video/audio)
- [x] เพิ่ม admin dashboard ✅ UI + REST API ที่ /admin
- [x] รองรับ multi-provider (GPT, Gemini) ✅ Gemini + Ollama + Anthropic + auto-fallback

## Priority: Medium
- [ ] เพิ่ม error retry + exponential backoff เมื่อ API ล่ม (ตอนนี้มี fallback provider แต่ไม่มี auto-retry)
- [ ] แก้ปัญหา LINE reply token หมดอายุ — fallback เป็น push message ถ้า AI ตอบช้า (infrastructure มีแล้ว แต่ logic ยังไม่ครบ)

## Priority: Low
- [ ] รองรับ group chat (ตอนนี้รองรับแค่ DM)
- [ ] ใช้ ngrok / tunnel สำหรับ webhook (โค้ดรองรับแล้ว เป็น deployment step)
