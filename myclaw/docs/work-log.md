# Work Log

## 2026-02-21 (Session 1)
- สร้างโปรเจกต์ MyClaw Mini
- เชื่อมต่อ LINE webhook (Express + @line/bot-sdk)
- เชื่อมต่อ Claude API (@anthropic-ai/sdk)
- สร้าง core do-until agent loop (src/ai.ts)
- สร้าง tool system รองรับการเพิ่ม tool ใหม่ (src/tools/)
- เพิ่มตัวอย่าง tool: get_datetime
- TypeScript compile ผ่าน, server start ได้
- เขียน README.md พร้อมเอกสารครบ + กฎ 3 ข้อ

## 2026-02-21 (Session 1 ต่อ) — เพิ่ม Memory System
- สร้าง memory system แบบ OpenClaw mini:
  - src/memory/types.ts — types + default config
  - src/memory/store.ts — SQLite storage (chunks + FTS5 + sessions)
  - src/memory/chunker.ts — ตัดข้อความเป็น chunks (400 tokens, 80 overlap)
  - src/memory/embeddings.ts — OpenAI text-embedding-3-small + cosine similarity
  - src/memory/search.ts — Hybrid search (vector 70% + keyword 30%)
  - src/memory/manager.ts — API หลัก (save, load, search, format)
  - src/memory/index.ts — exports
- เชื่อม memory เข้ากับ ai.ts:
  - โหลด history จาก DB (persist across restart)
  - ค้นหา memory ที่เกี่ยวข้องก่อนส่ง AI
  - inject memory context เข้า system prompt
  - บันทึกทุก message ลง DB + index เข้า memory
- เพิ่ม better-sqlite3 dependency
- เพิ่ม OPENAI_API_KEY ใน .env.example
- TypeScript compile ผ่าน
