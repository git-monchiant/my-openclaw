/**
 * Agent Registry — SQLite CRUD + seed + recommend
 * DB tables: agents, skills, agent_skills
 */

import { getDb } from "../memory/store.js";
import type { AgentConfig, SkillConfig, RecommendResult } from "./types.js";

// ===== DB Setup =====
let tablesReady = false;

function ensureAgentsTables(dataDir: string): void {
  if (tablesReady) return;
  const db = getDb(dataDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT,
      enabled INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      prompt_hint TEXT,
      tools TEXT NOT NULL DEFAULT '[]',
      tool_type TEXT DEFAULT 'non-ai',
      keywords TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      PRIMARY KEY (agent_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      user_id TEXT,
      task TEXT,
      detail TEXT,
      status TEXT DEFAULT 'ok',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agent_logs_agent ON agent_logs(agent_id, created_at DESC);
  `);

  // Migration: add columns added after initial schema
  try { db.exec("ALTER TABLE agents ADD COLUMN api_key TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE agents ADD COLUMN type TEXT NOT NULL DEFAULT 'agent'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE agents ADD COLUMN allowed_tools TEXT"); } catch { /* already exists */ }
  // Set orchestrator type for id='00'
  db.prepare("UPDATE agents SET type = 'orchestrator' WHERE id = '00' AND type != 'orchestrator'").run();

  // Seed if empty
  const agentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as any)?.cnt || 0;
  if (agentCount === 0) seedDefaults(db);

  // Migrate: add missing skills (e.g. Google skills added after initial seed)
  ensureMissingSkills(db);

  // Migrate: add missing agents (e.g. specialist agents added after initial seed)
  ensureMissingAgents(db);

  // Ensure orchestrator row exists (id = '00')
  ensureOrchestratorRow(db);

  tablesReady = true;
}

// ===== Migration: insert skills that were added after initial seed =====
function ensureMissingSkills(db: ReturnType<typeof getDb>): void {
  const expectedSkills: Array<[string, string, string, string | null, string[], string, string[]]> = [
    ["email", "Email", "Read, send, and manage Gmail", null, ["gmail", "google_link"], "non-ai", ["อีเมล", "email", "inbox", "ส่งเมล", "gmail", "mail"]],
    ["calendar_mgmt", "Calendar", "Manage Google Calendar events", null, ["calendar", "google_link"], "non-ai", ["ปฏิทิน", "calendar", "นัด", "event", "meeting", "นัดหมาย"]],
    ["cloud_storage", "Cloud Storage", "Manage files in Google Drive", null, ["drive", "google_link"], "non-ai", ["ไดรฟ์", "drive", "ไฟล์", "upload", "อัพโหลด", "file"]],
    ["spreadsheet", "Spreadsheet", "Read and write Google Sheets", null, ["sheets", "google_link"], "non-ai", ["ชีท", "sheets", "excel", "ตาราง", "spreadsheet", "ข้อมูล"]],
    ["api_integration", "API Integration", "Call external REST APIs", null, ["custom_api"], "non-ai", ["api", "เรียก", "fetch", "endpoint", "webhook", "ดึงข้อมูล"]],
    ["places", "Places & Location", "Search for places and send map locations", null, ["places"], "non-ai", ["สถานที่", "ที่ไหน", "location", "map", "แผนที่", "ร้าน", "ที่อยู่", "พิกัด", "ใกล้", "อยู่ตรงไหน"]],
    ["webapp", "Web App & Code Runner", "Generate HTML apps/games or run Python scripts", null, ["webapp"], "non-ai", ["เกม", "game", "เขียนโปรแกรม", "webapp", "app", "เล่น", "tetris", "snake", "quiz", "calculator", "python", "โค้ด", "คำนวณ", "chart", "กราฟ"]],
    ["user_profile_mgmt", "User Profile", "Get and set user preferences and personal info", null, ["user_profile"], "non-ai", ["ชื่อ", "เรียกว่า", "name", "nickname", "ชื่อเล่น", "preference", "profile"]],
    ["translation", "Translation", "Translate text between languages", null, [], "ai", ["แปล", "translate", "translation", "แปลภาษา", "แปลว่า", "แปลเป็น", "แปลจาก", "แปลคำ", "แปลข้อความ", "ภาษาอังกฤษ", "ภาษาญี่ปุ่น", "ภาษาจีน", "ภาษาเกาหลี"]],
    ["summarize", "Summarize", "Fetch and summarize web articles, news, and documents", null, ["web_search", "web_fetch", "browser"], "ai", ["สรุป", "summarize", "ย่อ", "สรุปบทความ", "สรุปเว็บ", "สรุปข่าว", "สรุปลิงก์", "ย่อบทความ", "tldr", "TLDR", "สรุปให้", "ย่อให้"]],
    ["ocr", "OCR / Text Extraction", "Extract text from images, documents, and screenshots", null, [], "ai", ["ocr", "อ่านตัวอักษร", "สแกนข้อความ", "ถอดข้อความ", "อ่านป้าย", "อ่านสลิป", "อ่านใบเสร็จ", "อ่านเอกสาร", "text extraction", "อ่านข้อความในรูป"]],
    ["calculate", "Calculate", "Perform calculations and unit conversions", null, [], "ai", ["คำนวณ", "calculate", "แปลงหน่วย", "unit conversion", "convert", "เปอร์เซ็นต์", "ดอกเบี้ย", "ภาษี", "vat", "เงิน", "คิดราคา", "แปลง"]],
    ["todo", "To-Do List", "Manage personal task and to-do lists", null, ["todo"], "non-ai", ["todo", "to-do", "รายการงาน", "สิ่งที่ต้องทำ", "งาน", "task", "เพิ่มงาน", "ดูรายการ", "ทำเสร็จ", "เช็คลิสต์", "checklist", "จดไว้", "อย่าลืม"]],
    ["expense", "Expense Tracker", "Log and query personal expenses and income", null, ["expense"], "non-ai", ["รายจ่าย", "ค่าใช้จ่าย", "บันทึกค่าใช้จ่าย", "expense", "จ่าย", "ซื้อ", "ใช้เงิน", "รายได้", "income", "เงินเข้า", "สรุปรายจ่าย", "งบประมาณ"]],
    ["health", "Health Tracker", "Log and track personal health metrics", null, ["expense"], "non-ai", ["สุขภาพ", "health", "น้ำหนัก", "ออกกำลังกาย", "exercise", "แคล", "calories", "วิ่ง", "นอน", "sleep", "steps", "ก้าว", "บันทึกสุขภาพ"]],
  ];

  const now = new Date().toISOString();
  const defaultAgent = db.prepare("SELECT id FROM agents WHERE id != '00' AND enabled = 1 ORDER BY name ASC LIMIT 1").get() as any;
  let added = 0;

  for (const [id, name, desc, hint, tools, toolType, keywords] of expectedSkills) {
    const exists = db.prepare("SELECT 1 FROM skills WHERE id = ?").get(id);
    if (!exists) {
      db.prepare(`
        INSERT INTO skills (id, name, description, prompt_hint, tools, tool_type, keywords, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, name, desc, hint, JSON.stringify(tools), toolType, JSON.stringify(keywords), now);

      // Link to default agent
      if (defaultAgent) {
        db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)").run(defaultAgent.id, id, 5);
      }
      added++;
    } else {
      // Update tools, tool_type, and keywords if skill exists but has stale data
      db.prepare("UPDATE skills SET tools = ?, tool_type = ?, keywords = ? WHERE id = ?").run(JSON.stringify(tools), toolType, JSON.stringify(keywords), id);
    }
  }

  // Fix writing skill: remove แปล/translate/สรุป/summarize (moved to dedicated skills)
  const writingSkill = db.prepare("SELECT keywords FROM skills WHERE id = 'writing'").get() as any;
  if (writingSkill) {
    try {
      const remove = new Set(["แปล", "translate", "สรุป", "summarize"]);
      const kws: string[] = JSON.parse(writingSkill.keywords);
      const filtered = kws.filter((k) => !remove.has(k));
      if (filtered.length !== kws.length) {
        db.prepare("UPDATE skills SET keywords = ? WHERE id = 'writing'").run(JSON.stringify(filtered));
      }
    } catch { /* ignore */ }
  }

  if (added > 0) {
    console.log(`[agents] Migration: added ${added} missing skills`);
  }
}

// ===== Migration: create specialist agents added after initial seed =====
function ensureMissingAgents(db: ReturnType<typeof getDb>): void {
  const now = new Date().toISOString();

  const translatorExists = db.prepare("SELECT id FROM agents WHERE id = 'translator'").get();
  if (!translatorExists) {
    const systemPrompt = [
      "You are a language translation specialist. Translate accurately and naturally between any languages.",
      "Current date/time: provided in tasks.",
      "FORMATTING: You are on LINE chat — no markdown. Use plain text only.",
      "",
      "Translation guidelines:",
      "- Detect the source language automatically if not specified",
      "- Translate naturally, preserving meaning and tone — not word-for-word",
      "- Thai↔English: most common pair, translate fluently",
      "- Other languages (Japanese, Chinese, Korean, French, etc.): translate accurately",
      "- Short phrases/words: give translation + brief note if helpful (e.g. formal vs informal)",
      "- Paragraphs/documents: translate fully without summarizing",
      "- Pronunciation questions (ออกเสียงยังไง, how to pronounce): explain in text (phonetics/romanization), do NOT create audio",
      "",
      "Reply format:",
      "- Translation only (+ brief note if helpful)",
      "- Keep it concise and clean for phone screen",
      "- NEVER say 'I'll translate' — just do it immediately",
    ].join("\n");

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, api_key, system_prompt, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?)
    `).run(
      "translator",
      "05-Trans",
      "Language translation specialist — Thai, English, Japanese, Chinese, Korean, and more",
      "openrouter",
      "google/gemini-2.5-flash",
      systemPrompt,
      now, now,
    );

    // Auto-assign non-AI skills + translation skill
    const nonAiSkills = db.prepare("SELECT id FROM skills WHERE tool_type = 'non-ai'").all() as Array<{ id: string }>;
    const insertLink = db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");
    for (const s of nonAiSkills) {
      insertLink.run("translator", s.id, 5);
    }
    insertLink.run("translator", "translation", 10);

    console.log("[agents] Migration: created translator agent (05-Trans)");
  }

  const summarizerExists = db.prepare("SELECT id FROM agents WHERE id = 'summarizer'").get();
  if (!summarizerExists) {
    const systemPrompt = [
      "You are a content summarization specialist. Fetch and summarize web articles, news, and documents clearly and concisely.",
      "FORMATTING: You are on LINE chat — no markdown. Use plain text with line breaks only.",
      "",
      "Summarization guidelines:",
      "- If given a URL: fetch it first, then summarize the content",
      "- If given a topic: search for relevant articles, then summarize key points",
      "- If given raw text: summarize it directly",
      "- Keep summaries concise — 3-6 bullet points or short paragraphs for phone screen",
      "- Include: main point, key details, conclusion (if applicable)",
      "- Preserve factual accuracy — do NOT fabricate or embellish",
      "- Use plain bullets (•) instead of markdown",
      "- Reply in the SAME language the user used (Thai if Thai, English if English)",
      "",
      "Reply format example:",
      "📰 [Article title or topic]",
      "• Key point 1",
      "• Key point 2",
      "• Key point 3",
      "สรุป: [one-sentence conclusion]",
    ].join("\n");

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, api_key, system_prompt, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?)
    `).run(
      "summarizer",
      "06-Sum",
      "Content summarization — articles, news, web pages, and documents",
      "openrouter",
      "google/gemini-2.5-flash",
      systemPrompt,
      now, now,
    );

    // Auto-assign non-AI skills + summarize skill
    const nonAiSkillsSum = db.prepare("SELECT id FROM skills WHERE tool_type = 'non-ai'").all() as Array<{ id: string }>;
    const insertLinkSum = db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");
    for (const s of nonAiSkillsSum) {
      insertLinkSum.run("summarizer", s.id, 5);
    }
    insertLinkSum.run("summarizer", "summarize", 10);

    console.log("[agents] Migration: created summarizer agent (06-Sum)");
  }

  // Assign ocr skill to image analysis agent (02-Vision / agent-02)
  const visionAgent = db.prepare("SELECT id FROM agents WHERE id IN ('agent-02', 'vision') LIMIT 1").get() as any;
  if (visionAgent) {
    db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)").run(visionAgent.id, "ocr", 10);
  }

  const dataAgentExists = db.prepare("SELECT id FROM agents WHERE id = 'data-mgr'").get();
  if (!dataAgentExists) {
    const systemPrompt = [
      "You are a personal data assistant. You manage to-do lists, expense/income logs, and health metrics for the user.",
      "FORMATTING: You are on LINE chat — no markdown. Use plain text with line breaks and simple bullets (•) only.",
      "",
      "Guidelines:",
      "- To-do list: use the todo tool. Show tasks clearly with their ID numbers for easy reference.",
      "- Expenses/income: use the expense tool (type='expense' or 'income'). Always confirm amount, category, date.",
      "- Health metrics: use the expense tool (type='health'). category = metric name e.g. weight_kg, steps, sleep_hours.",
      "- Present numbers clearly: amounts with commas (1,500 บาท), dates in Thai format if possible.",
      "- Reply in the SAME language the user used (Thai if Thai).",
      "- After any log/add action: confirm what was saved briefly.",
      "- For summary/list: present data in a clean, readable format for phone screen.",
    ].join("\n");

    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, api_key, system_prompt, enabled, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?)
    `).run(
      "data-mgr",
      "07-Data",
      "Personal data manager — to-do lists, expenses, income, health metrics",
      "openrouter",
      "openai/gpt-4o-mini",
      systemPrompt,
      now, now,
    );

    // Auto-assign non-AI skills + specialist skills
    const nonAiSkillsData = db.prepare("SELECT id FROM skills WHERE tool_type = 'non-ai'").all() as Array<{ id: string }>;
    const insertLinkData = db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");
    for (const s of nonAiSkillsData) {
      insertLinkData.run("data-mgr", s.id, 5);
    }
    // Assign specialist AI skills
    for (const skillId of ["todo", "expense", "health", "calculate"]) {
      insertLinkData.run("data-mgr", skillId, 10);
    }

    console.log("[agents] Migration: created data manager agent (07-Data)");
  }
}

// ===== Seed Data =====
function seedDefaults(db: ReturnType<typeof getDb>): void {
  const now = new Date().toISOString();

  // Default agent: Gemini
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, system_prompt, enabled, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, 1, 1, ?, ?)
  `).run("gemini", "Gemini", "Default AI assistant — multimodal, free tier", "gemini", "gemini-2.5-flash", now, now);

  // Skills
  const skills: Array<[string, string, string, string | null, string[], string, string[]]> = [
    // [id, name, description, prompt_hint, tools, tool_type, keywords]
    ["general_chat", "General Chat", "General conversation and Q&A", null, [], "non-ai", []],
    ["image_analysis", "Image Analysis", "Analyze and describe images", null, ["image"], "ai", ["รูป", "image", "ดูรูป", "วิเคราะห์รูป", "photo", "picture"]],
    ["image_creation", "Image Creation", "Generate images from text", null, ["image"], "ai", ["สร้างรูป", "วาดรูป", "generate image", "draw"]],
    ["audio_video", "Audio & Video", "Transcribe and analyze audio/video", null, [], "ai", ["เสียง", "audio", "video", "ถอดเสียง", "transcribe", "วิดีโอ"]],
    ["tts", "Text to Speech", "Generate spoken audio from text", null, ["tts"], "ai", ["พูด", "อ่าน", "tts", "speech", "เสียงพูด"]],
    ["web_research", "Web Research", "Search and fetch web content", null, ["web_search", "web_fetch"], "non-ai", ["ค้นหา", "search", "หา", "ข่าว", "google"]],
    ["scheduling", "Scheduling", "Create reminders and scheduled tasks", null, ["cron", "datetime"], "non-ai", ["เตือน", "นัด", "schedule", "alarm", "cron", "remind"]],
    ["memory", "Memory", "Search and recall past conversations", null, ["memory_search", "memory_get"], "non-ai", ["จำ", "remember", "เคย", "เมื่อวาน", "ที่แล้ว"]],
    ["messaging", "Messaging", "Send messages and notifications", null, ["message", "sessions_send", "canvas"], "non-ai", ["ส่ง", "send", "broadcast", "แจ้ง"]],
    ["coding", "Coding", "Write and analyze code", null, [], "ai", ["code", "โค้ด", "program", "debug", "function", "เขียนโค้ด"]],
    ["writing", "Writing", "Write and draft text", null, [], "ai", ["เขียน", "write", "ร่าง", "เรียบเรียง"]],
    ["translation", "Translation", "Translate text between languages", null, [], "ai", ["แปล", "translate", "translation", "แปลภาษา", "แปลว่า", "แปลเป็น", "แปลจาก", "แปลคำ", "แปลข้อความ", "ภาษาอังกฤษ", "ภาษาญี่ปุ่น", "ภาษาจีน", "ภาษาเกาหลี"]],
    ["summarize", "Summarize", "Fetch and summarize web articles, news, and documents", null, ["web_search", "web_fetch", "browser"], "ai", ["สรุป", "summarize", "ย่อ", "สรุปบทความ", "สรุปเว็บ", "สรุปข่าว", "สรุปลิงก์", "ย่อบทความ", "tldr", "TLDR", "สรุปให้", "ย่อให้"]],
    ["ocr", "OCR / Text Extraction", "Extract text from images, documents, and screenshots", null, [], "ai", ["ocr", "อ่านตัวอักษร", "สแกนข้อความ", "ถอดข้อความ", "อ่านป้าย", "อ่านสลิป", "อ่านใบเสร็จ", "อ่านเอกสาร", "text extraction", "อ่านข้อความในรูป"]],
    ["calculate", "Calculate", "Perform calculations and unit conversions", null, [], "ai", ["คำนวณ", "calculate", "แปลงหน่วย", "unit conversion", "convert", "เปอร์เซ็นต์", "ดอกเบี้ย", "ภาษี", "vat", "เงิน", "คิดราคา", "แปลง"]],
    ["todo", "To-Do List", "Manage personal task and to-do lists", null, ["todo"], "non-ai", ["todo", "to-do", "รายการงาน", "สิ่งที่ต้องทำ", "งาน", "task", "เพิ่มงาน", "ดูรายการ", "ทำเสร็จ", "เช็คลิสต์", "checklist", "จดไว้", "อย่าลืม"]],
    ["expense", "Expense Tracker", "Log and query personal expenses and income", null, ["expense"], "non-ai", ["รายจ่าย", "ค่าใช้จ่าย", "บันทึกค่าใช้จ่าย", "expense", "จ่าย", "ซื้อ", "ใช้เงิน", "รายได้", "income", "เงินเข้า", "สรุปรายจ่าย", "งบประมาณ"]],
    ["health", "Health Tracker", "Log and track personal health metrics", null, ["expense"], "non-ai", ["สุขภาพ", "health", "น้ำหนัก", "ออกกำลังกาย", "exercise", "แคล", "calories", "วิ่ง", "นอน", "sleep", "steps", "ก้าว", "บันทึกสุขภาพ"]],
    ["browser", "Browser Control", "Control browser and take screenshots", null, ["browser"], "non-ai", ["browser", "เปิดเว็บ", "screenshot", "เว็บ"]],
    ["email", "Email", "Read, send, and manage Gmail", null, ["gmail", "google_link"], "non-ai", ["อีเมล", "email", "inbox", "ส่งเมล", "gmail", "mail"]],
    ["calendar_mgmt", "Calendar", "Manage Google Calendar events", null, ["calendar", "google_link"], "non-ai", ["ปฏิทิน", "calendar", "นัด", "event", "meeting", "นัดหมาย"]],
    ["cloud_storage", "Cloud Storage", "Manage files in Google Drive", null, ["drive", "google_link"], "non-ai", ["ไดรฟ์", "drive", "ไฟล์", "upload", "อัพโหลด", "file"]],
    ["spreadsheet", "Spreadsheet", "Read and write Google Sheets", null, ["sheets", "google_link"], "non-ai", ["ชีท", "sheets", "excel", "ตาราง", "spreadsheet", "ข้อมูล"]],
    ["api_integration", "API Integration", "Call external REST APIs", null, ["custom_api"], "non-ai", ["api", "เรียก", "fetch", "endpoint", "webhook", "ดึงข้อมูล"]],
    ["places", "Places & Location", "Search for places and send map locations", null, ["places"], "non-ai", ["สถานที่", "ที่ไหน", "location", "map", "แผนที่", "ร้าน", "ที่อยู่", "พิกัด", "ใกล้", "อยู่ตรงไหน"]],
    ["webapp", "Web App & Code Runner", "Generate HTML apps/games or run Python scripts", null, ["webapp"], "non-ai", ["เกม", "game", "เขียนโปรแกรม", "webapp", "app", "เล่น", "tetris", "snake", "quiz", "calculator", "python", "โค้ด", "คำนวณ", "chart", "กราฟ"]],
    ["user_profile_mgmt", "User Profile", "Get and set user preferences and personal info", null, ["user_profile"], "non-ai", ["ชื่อ", "เรียกว่า", "name", "nickname", "ชื่อเล่น", "preference", "profile"]],
  ];

  const insertSkill = db.prepare(`
    INSERT INTO skills (id, name, description, prompt_hint, tools, tool_type, keywords, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLink = db.prepare(`
    INSERT INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)
  `);

  // Gemini skill priorities
  const geminiPriorities: Record<string, number> = {
    general_chat: 10, image_analysis: 10, image_creation: 8, audio_video: 10,
    tts: 10, web_research: 8, scheduling: 5, memory: 5, messaging: 5,
    coding: 5, writing: 6, translation: 5, summarize: 5, ocr: 5, calculate: 5,
    todo: 5, expense: 5, health: 5, browser: 5, email: 5, calendar_mgmt: 5,
    cloud_storage: 5, spreadsheet: 5, api_integration: 5,
  };

  for (const [id, name, desc, hint, tools, toolType, keywords] of skills) {
    insertSkill.run(id, name, desc, hint, JSON.stringify(tools), toolType, JSON.stringify(keywords), now);
    const priority = geminiPriorities[id] || 5;
    insertLink.run("gemini", id, priority);
  }

  console.log(`[agents] Seeded default agent (Gemini) + ${skills.length} skills`);
}

// ===== Orchestrator row (id='00') =====
const DEFAULT_ORCHESTRATOR_TOOLS = ["delegate_task", "get_datetime", "memory_search", "memory_get", "google_link", "cron", "user_profile"];

function ensureOrchestratorRow(db: ReturnType<typeof getDb>): void {
  const exists = db.prepare("SELECT id FROM agents WHERE id = '00'").get() as any;
  if (!exists) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO agents (id, name, description, provider, model, api_key, system_prompt, allowed_tools, enabled, is_default, created_at, updated_at)
      VALUES ('00', 'MyClaw', 'Main AI orchestrator — uses GEMINI_API_KEY from env, routes all requests to specialist agents', 'gemini', 'gemini-2.5-flash', NULL, NULL, ?, 1, 0, ?, ?)
    `).run(JSON.stringify(DEFAULT_ORCHESTRATOR_TOOLS), now, now);
    console.log("[agents] Created orchestrator row (00)");
  } else if (!exists.allowed_tools) {
    // Migrate: set default tools if column is empty
    db.prepare("UPDATE agents SET allowed_tools = ? WHERE id = '00'").run(JSON.stringify(DEFAULT_ORCHESTRATOR_TOOLS));
  }
}

export function getOrchestratorAgent(dataDir: string): AgentConfig {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  // Active orchestrator = type='orchestrator'; fallback to first fallback if none
  const row = db.prepare("SELECT * FROM agents WHERE type = 'orchestrator' LIMIT 1").get()
    ?? db.prepare("SELECT * FROM agents WHERE type = 'fallback' LIMIT 1").get();
  if (!row) throw new Error("No orchestrator found");
  return rowToAgent(row);
}

/** เลือกตัว active orchestrator: ตัวที่เลือก → type='orchestrator', ที่เหลือ (orchestrator/fallback) → type='fallback' */
export function setActiveOrchestrator(dataDir: string, id: string): AgentConfig | null {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const target = getAgent(dataDir, id);
  if (!target) return null;
  // Demote all current orchestrator/fallback rows to 'fallback'
  db.prepare("UPDATE agents SET type = 'fallback', updated_at = ? WHERE type IN ('orchestrator', 'fallback')").run(new Date().toISOString());
  // Promote selected to 'orchestrator'
  db.prepare("UPDATE agents SET type = 'orchestrator', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  console.log(`[agents] Active orchestrator → "${target.name}" (${id})`);
  return getAgent(dataDir, id);
}

// ===== Row → Config mappers =====
function rowToAgent(row: any): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    type: (row.type || "agent") as AgentConfig["type"],
    provider: row.provider,
    model: row.model,
    apiKey: row.api_key || null,
    systemPrompt: row.system_prompt || null,
    allowedTools: row.allowed_tools ? (() => { try { return JSON.parse(row.allowed_tools); } catch { return null; } })() : null,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSkill(row: any): SkillConfig {
  let tools: string[] = [];
  let keywords: string[] = [];
  try { tools = JSON.parse(row.tools); } catch { /* ignore */ }
  try { keywords = JSON.parse(row.keywords); } catch { /* ignore */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    promptHint: row.prompt_hint || null,
    tools,
    toolType: row.tool_type === "ai" ? "ai" : "non-ai",
    keywords,
    createdAt: row.created_at,
  };
}

// ===== Agent CRUD =====

export function getActiveAgent(dataDir: string): AgentConfig {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  // Only agent type — exclude orchestrator and fallback
  const row = db.prepare("SELECT * FROM agents WHERE type = 'agent' AND enabled = 1 ORDER BY name ASC LIMIT 1").get();
  if (!row) throw new Error("No enabled agents found");
  return rowToAgent(row);
}

export function listAgents(dataDir: string): AgentConfig[] {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  // Orchestrator first, then agents alphabetically
  const rows = db.prepare("SELECT * FROM agents ORDER BY CASE WHEN type='orchestrator' THEN 0 ELSE 1 END, name ASC").all();
  return rows.map(rowToAgent);
}

export function getAgent(dataDir: string, id: string): AgentConfig | null {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  return row ? rowToAgent(row) : null;
}

export function createAgent(dataDir: string, input: {
  id: string; name: string; description?: string;
  provider: string; model: string; apiKey?: string; systemPrompt?: string;
}): AgentConfig {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, api_key, system_prompt, enabled, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(input.id, input.name, input.description || "", input.provider, input.model, input.apiKey || null, input.systemPrompt || null, now, now);

  // Auto-assign non-AI skills ให้ agent ใหม่ (เครื่องมือพื้นฐาน ไม่กิน tokens)
  const nonAiSkills = db.prepare("SELECT id FROM skills WHERE tool_type = 'non-ai'").all() as Array<{ id: string }>;
  const insertLink = db.prepare("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");
  for (const s of nonAiSkills) {
    insertLink.run(input.id, s.id, 5);
  }

  console.log(`[agents] Created agent "${input.name}" (${input.id}) + auto-assigned ${nonAiSkills.length} non-AI skills`);
  return getAgent(dataDir, input.id)!;
}

export function updateAgent(dataDir: string, id: string, partial: Partial<{
  name: string; description: string; provider: string; model: string;
  apiKey: string | null; systemPrompt: string | null; enabled: boolean;
  allowedTools: string[] | null;
}>): AgentConfig | null {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const existing = getAgent(dataDir, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const vals: any[] = [now];

  if (partial.name !== undefined) { sets.push("name = ?"); vals.push(partial.name); }
  if (partial.description !== undefined) { sets.push("description = ?"); vals.push(partial.description); }
  if (partial.provider !== undefined) { sets.push("provider = ?"); vals.push(partial.provider); }
  if (partial.model !== undefined) { sets.push("model = ?"); vals.push(partial.model); }
  if (partial.apiKey !== undefined) { sets.push("api_key = ?"); vals.push(partial.apiKey); }
  if (partial.systemPrompt !== undefined) { sets.push("system_prompt = ?"); vals.push(partial.systemPrompt); }
  if (partial.allowedTools !== undefined) { sets.push("allowed_tools = ?"); vals.push(partial.allowedTools ? JSON.stringify(partial.allowedTools) : null); }
  if (partial.enabled !== undefined) { sets.push("enabled = ?"); vals.push(partial.enabled ? 1 : 0); }

  vals.push(id);
  db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  console.log(`[agents] Updated agent "${id}"`);
  return getAgent(dataDir, id);
}

export function deleteAgent(dataDir: string, id: string): { success: boolean; error?: string } {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const agent = getAgent(dataDir, id);
  if (!agent) return { success: false, error: "not_found" };
  if (agent.type === "orchestrator") return { success: false, error: "cannot_delete_orchestrator" };

  db.prepare("DELETE FROM agent_skills WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  console.log(`[agents] Deleted agent "${agent.name}" (${id})`);
  return { success: true };
}


// ===== Skills =====

export function listSkills(dataDir: string): SkillConfig[] {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  return db.prepare("SELECT * FROM skills ORDER BY name ASC").all().map(rowToSkill);
}

export function getAgentSkills(dataDir: string, agentId: string): Array<SkillConfig & { priority: number }> {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const rows = db.prepare(`
    SELECT s.*, ask.priority
    FROM skills s
    JOIN agent_skills ask ON ask.skill_id = s.id
    WHERE ask.agent_id = ?
    ORDER BY ask.priority DESC, s.name ASC
  `).all(agentId) as any[];

  return rows.map((r) => ({ ...rowToSkill(r), priority: r.priority }));
}

export function assignSkill(dataDir: string, agentId: string, skillId: string, priority = 5): void {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  db.prepare(`
    INSERT OR REPLACE INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)
  `).run(agentId, skillId, priority);
}

export function removeSkill(dataDir: string, agentId: string, skillId: string): void {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  db.prepare("DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?").run(agentId, skillId);
}

// ===== Recommend =====

export function recommendAgent(dataDir: string, message: string): RecommendResult {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const msgLower = message.toLowerCase();

  // Get all skills with their keywords
  const allSkills = listSkills(dataDir);

  // Match keywords
  let bestSkill: SkillConfig | null = null;
  let bestScore = 0;

  for (const skill of allSkills) {
    if (skill.id === "general_chat") continue; // skip generic
    let score = 0;
    for (const kw of skill.keywords) {
      if (msgLower.includes(kw.toLowerCase())) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  if (!bestSkill || bestScore === 0) {
    // No match → default agent with general_chat
    const defaultAgent = getActiveAgent(dataDir);
    return { agent: defaultAgent, skill: null, reason: "default (no skill match)" };
  }

  // Find agent with highest priority for this skill
  const row = db.prepare(`
    SELECT a.*, ask.priority
    FROM agents a
    JOIN agent_skills ask ON ask.agent_id = a.id
    WHERE ask.skill_id = ? AND a.enabled = 1
    ORDER BY ask.priority DESC
    LIMIT 1
  `).get(bestSkill.id) as any;

  if (!row) {
    const defaultAgent = getActiveAgent(dataDir);
    return { agent: defaultAgent, skill: bestSkill, reason: `skill "${bestSkill.name}" matched but no agent assigned` };
  }

  return {
    agent: rowToAgent(row),
    skill: bestSkill,
    reason: `skill "${bestSkill.name}" → agent "${row.name}" (priority ${row.priority})`,
  };
}

// ===== Resolve best agent for a skill (used by planner) =====

export function resolveAgentForSkill(dataDir: string, skillId: string): string | null {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const row = db.prepare(`
    SELECT a.id FROM agents a
    JOIN agent_skills ask ON ask.agent_id = a.id
    WHERE ask.skill_id = ? AND a.enabled = 1
    ORDER BY ask.priority DESC
    LIMIT 1
  `).get(skillId) as { id: string } | undefined;
  return row?.id ?? null;
}

// ===== Agents with skills (for API) =====

export function listAgentsWithSkills(dataDir: string): AgentConfig[] {
  // Only delegate-able agents (type = 'agent')
  const agents = listAgents(dataDir).filter((a) => a.type === "agent");
  return agents.map((a) => ({
    ...a,
    skills: getAgentSkills(dataDir, a.id),
  }));
}

// ===== Agent Activity Log =====

export function logAgentActivity(dataDir: string, entry: {
  agentId: string;
  type: "delegate" | "tool_call" | "response";
  userId?: string;
  task?: string;
  detail?: string;
  status?: "ok" | "error";
}): void {
  try {
    ensureAgentsTables(dataDir);
    const db = getDb(dataDir);
    db.prepare(`
      INSERT INTO agent_logs (agent_id, type, user_id, task, detail, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.agentId,
      entry.type,
      entry.userId || null,
      entry.task || null,
      entry.detail ? entry.detail.substring(0, 500) : null,
      entry.status || "ok",
    );
  } catch (err) {
    console.error("[agent_logs] Failed to log:", err);
  }
}

export function getAgentLogs(dataDir: string, agentId: string, limit = 50, offset = 0): {
  logs: Array<{
    id: number; agentId: string; type: string; userId: string | null;
    task: string | null; detail: string | null; status: string; createdAt: string;
  }>;
  total: number;
} {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM agent_logs WHERE agent_id = ?").get(agentId) as any)?.cnt || 0;
  const rows = db.prepare(`
    SELECT * FROM agent_logs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(agentId, limit, offset) as any[];

  return {
    logs: rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      type: r.type,
      userId: r.user_id,
      task: r.task,
      detail: r.detail,
      status: r.status,
      createdAt: r.created_at,
    })),
    total,
  };
}
