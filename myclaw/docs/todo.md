# Todo

## Priority: High
- [ ] ใส่ credentials จริง (.env) แล้วทดสอบกับ LINE จริง
- [ ] ใช้ ngrok เปิด tunnel สำหรับ webhook
- [ ] ทดสอบ do-until loop ว่า AI เรียก tool ได้จริง
- [ ] ทดสอบ memory system (บันทึก + ค้นหา)

## Priority: Medium
- [ ] เพิ่ม error retry เมื่อ Claude API ล่ม
- [ ] แก้ปัญหา LINE reply token หมดอายุ (เปลี่ยนเป็น push message ถ้า AI ตอบช้า)
- [ ] เพิ่ม tool: web_search
- [ ] เพิ่ม tool: http_request

## Priority: Low
- [x] ~~เพิ่ม memory system (vector search)~~ ✅ เสร็จแล้ว
- [ ] รองรับรูปภาพจาก LINE
- [ ] รองรับ group chat
- [ ] เพิ่ม admin dashboard
- [ ] รองรับ multi-provider (GPT, Gemini)
