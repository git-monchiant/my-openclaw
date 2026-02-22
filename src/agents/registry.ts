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
  `);

  // Seed if empty
  const agentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agents").get() as any)?.cnt || 0;
  if (agentCount === 0) seedDefaults(db);

  tablesReady = true;
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
    ["writing", "Writing", "Write, summarize, and translate text", null, [], "ai", ["เขียน", "write", "สรุป", "summarize", "แปล", "translate"]],
    ["browser", "Browser Control", "Control browser and take screenshots", null, ["browser"], "non-ai", ["browser", "เปิดเว็บ", "screenshot", "เว็บ"]],
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
    coding: 5, writing: 6, browser: 5,
  };

  for (const [id, name, desc, hint, tools, toolType, keywords] of skills) {
    insertSkill.run(id, name, desc, hint, JSON.stringify(tools), toolType, JSON.stringify(keywords), now);
    const priority = geminiPriorities[id] || 5;
    insertLink.run("gemini", id, priority);
  }

  console.log(`[agents] Seeded default agent (Gemini) + ${skills.length} skills`);
}

// ===== Row → Config mappers =====
function rowToAgent(row: any): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    provider: row.provider,
    model: row.model,
    systemPrompt: row.system_prompt || null,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
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
  const row = db.prepare("SELECT * FROM agents WHERE is_default = 1 AND enabled = 1 LIMIT 1").get();
  if (!row) {
    // Fallback: first enabled agent
    const fallback = db.prepare("SELECT * FROM agents WHERE enabled = 1 LIMIT 1").get();
    if (!fallback) throw new Error("No enabled agents found");
    return rowToAgent(fallback);
  }
  return rowToAgent(row);
}

export function listAgents(dataDir: string): AgentConfig[] {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const rows = db.prepare("SELECT * FROM agents ORDER BY is_default DESC, name ASC").all();
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
  provider: string; model: string; systemPrompt?: string;
}): AgentConfig {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, system_prompt, enabled, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  `).run(input.id, input.name, input.description || "", input.provider, input.model, input.systemPrompt || null, now, now);

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
  systemPrompt: string | null; enabled: boolean;
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
  if (partial.systemPrompt !== undefined) { sets.push("system_prompt = ?"); vals.push(partial.systemPrompt); }
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
  if (agent.isDefault) return { success: false, error: "cannot_delete_default" };

  db.prepare("DELETE FROM agent_skills WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  console.log(`[agents] Deleted agent "${agent.name}" (${id})`);
  return { success: true };
}

export function setDefaultAgent(dataDir: string, id: string): AgentConfig | null {
  ensureAgentsTables(dataDir);
  const db = getDb(dataDir);
  const agent = getAgent(dataDir, id);
  if (!agent) return null;

  db.prepare("UPDATE agents SET is_default = 0").run();
  db.prepare("UPDATE agents SET is_default = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  console.log(`[agents] Set default agent: "${agent.name}" (${id})`);
  return getAgent(dataDir, id);
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

// ===== Agents with skills (for API) =====

export function listAgentsWithSkills(dataDir: string): AgentConfig[] {
  const agents = listAgents(dataDir);
  return agents.map((a) => ({
    ...a,
    skills: getAgentSkills(dataDir, a.id),
  }));
}
