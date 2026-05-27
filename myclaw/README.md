# MyClaw Mini

Mini AI assistant เชื่อมต่อ LINE + Claude (Anthropic)
แรงบันดาลใจจาก [OpenClaw](https://github.com/openclaw/openclaw)

## สถาปัตยกรรม

```
LINE User
    │
    ▼
┌──────────────┐
│  Express     │  ← รับ webhook จาก LINE
│  /webhook    │
└──────┬───────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│  line.ts     │────▶│  ai.ts       │
│  รับ/ส่ง LINE │     │  do-until    │
└──────────────┘     │  loop        │
                     └──────┬───────┘
                            │
                   ┌────────┼────────┐
                   ▼        ▼        ▼
              ┌────────┐ ┌────────┐ ┌────────┐
              │Claude  │ │ Tools  │ │Session │
              │  API   │ │Registry│ │History │
              └────────┘ └────────┘ └────────┘
```

## โครงสร้างไฟล์

```
myclaw/
├── src/
│   ├── index.ts        ← Entry point (Express server)
│   ├── line.ts         ← LINE webhook handler (รับ/ส่งข้อความ)
│   ├── ai.ts           ← Core agent loop (do-until + Claude API)
│   └── tools/
│       ├── types.ts    ← ToolDefinition interface
│       ├── index.ts    ← Tool registry (เพิ่ม tool ที่นี่)
│       └── datetime.ts ← ตัวอย่าง tool
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Flow การทำงาน

```
1. User พิมพ์ข้อความใน LINE
2. LINE ส่ง webhook มาที่ /webhook
3. line.ts รับข้อความ → เรียก ai.ts
4. ai.ts เริ่ม do-until loop:
   ├─ ส่ง prompt + tools ไป Claude
   ├─ Claude ตอบกลับ:
   │   ├─ tool_use → รัน tool → ส่งผลกลับ → วนรอบใหม่
   │   └─ end_turn → หยุด loop
5. ai.ts ส่งคำตอบกลับ line.ts
6. line.ts ส่งข้อความกลับ LINE
7. User เห็นคำตอบ
```

## วิธีติดตั้ง

### 1. ติดตั้ง dependencies

```bash
cd myclaw
npm install
```

### 2. ตั้งค่า .env

```bash
cp .env.example .env
```

แก้ไฟล์ `.env` ใส่ค่าจริง:

| ตัวแปร | ได้จาก |
|--------|--------|
| `LINE_CHANNEL_ACCESS_TOKEN` | [LINE Developers Console](https://developers.line.biz/) → Messaging API |
| `LINE_CHANNEL_SECRET` | LINE Developers Console → Basic settings |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) |

### 3. รัน

```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

### 4. ตั้ง Webhook URL ที่ LINE Developers

ใช้ ngrok หรือ deploy ขึ้น server แล้วตั้ง webhook URL:

```
https://your-domain.com/webhook
```

## วิธีเพิ่ม Tool ใหม่

### ขั้นตอนที่ 1: สร้างไฟล์ tool

```typescript
// src/tools/web-search.ts
import type { ToolDefinition } from "./types.js";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the web for information",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query",
      },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const query = input.query as string;
    // ... implement search logic ...
    return `Results for: ${query}`;
  },
};
```

### ขั้นตอนที่ 2: Register ใน tools/index.ts

```typescript
import { webSearchTool } from "./web-search.js";

const allTools: ToolDefinition[] = [
  datetimeTool,
  webSearchTool,  // ← เพิ่มตรงนี้
];
```

เพียงแค่นี้ AI จะเห็น tool ใหม่และเรียกใช้ได้อัตโนมัติ

## ไอเดีย Tools ที่จะเพิ่มได้

| Tool | ทำอะไร |
|------|--------|
| `web_search` | ค้นหาข้อมูลจากเว็บ |
| `read_file` | อ่านไฟล์ |
| `write_file` | เขียนไฟล์ |
| `exec` | รัน shell command |
| `http_request` | เรียก REST API |
| `database_query` | Query ฐานข้อมูล |
| `send_email` | ส่งอีเมล |
| `image_generate` | สร้างรูปภาพ |

## กฎการทำงาน (Development Rules)

### กฎข้อ 1: ทำงานอย่าง senior programmer

คุณคือ programmer อายุงาน 30 ปี ทำงานรอบคอบ:

- **ไม่ส่งงานที่ยังไม่ได้ทดสอบ** ทุก feature ต้อง test ก่อน deliver เสมอ
- เขียน code ต้องคิดถึง edge cases, error handling
- แก้ bug ต้องหา root cause ไม่ใช่แค่แก้อาการ
- refactor ต้องมั่นใจว่าไม่มีอะไรพัง (test ก่อน-หลัง)

### กฎข้อ 2: จดบันทึกการทำงานเสมอ

ทุกครั้งที่ทำงาน ต้องเขียนบันทึกใน markdown:

- **`docs/work-log.md`** — บันทึกสิ่งที่ทำไปแล้ว (วันที่, สิ่งที่เปลี่ยน, เหตุผล)
- **`docs/todo.md`** — งานที่ต้องทำต่อ (จัดลำดับความสำคัญ)

ตัวอย่าง:

```markdown
<!-- docs/work-log.md -->
## 2026-02-21
- สร้างโปรเจกต์ MyClaw Mini
- เชื่อมต่อ LINE webhook + Claude API
- สร้าง tool system รองรับการเพิ่ม tool ใหม่
- เพิ่มตัวอย่าง tool: get_datetime

## 2026-02-22
- เพิ่ม web_search tool
- แก้ bug: LINE reply token หมดอายุเมื่อ AI ตอบช้า
```

```markdown
<!-- docs/todo.md -->
## Priority: High
- [ ] เพิ่ม error retry เมื่อ Claude API ล่ม
- [ ] รองรับรูปภาพจาก LINE

## Priority: Medium
- [ ] เพิ่ม web_search tool
- [ ] เพิ่ม memory system (vector search)

## Priority: Low
- [ ] รองรับ group chat
- [ ] เพิ่ม admin dashboard
```

### กฎข้อ 3: ก่อน compact ต้องเขียน md ก่อนเสมอ

เมื่อ context ใกล้เต็มหรือก่อนจะ compact conversation:

- **ต้องเขียน `docs/session-handoff.md`** ก่อนทุกครั้ง
- บันทึกสิ่งที่ทำค้างอยู่, สถานะปัจจุบัน, ขั้นตอนถัดไป
- เพื่อให้ session ใหม่ (หรือตัวเองหลัง compact) ทำงานต่อได้ทันที

ตัวอย่าง:

```markdown
<!-- docs/session-handoff.md -->
# Session Handoff — 2026-02-21 10:30

## กำลังทำอะไรอยู่
กำลังเพิ่ม web_search tool เขียน execute function เสร็จแล้ว
แต่ยังไม่ได้ register ใน tools/index.ts

## สถานะไฟล์
- src/tools/web-search.ts — เขียนเสร็จ ยังไม่ได้ test
- src/tools/index.ts — ยังไม่ได้เพิ่ม import

## ขั้นตอนถัดไป
1. register web_search ใน tools/index.ts
2. test ว่า AI เรียก tool ได้
3. test error cases (network fail, timeout)

## ปัญหาที่เจอ
- LINE reply token หมดอายุหลัง 30 วินาที
  ถ้า AI + tool ใช้เวลานาน ต้องเปลี่ยนเป็น push message แทน
```

## License

MIT
