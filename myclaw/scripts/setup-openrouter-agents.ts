/**
 * Setup OpenRouter agents — 5 specialized agents, all via OpenRouter
 * Disables old Gemini agents, creates new OpenRouter agents with skill assignments
 * Usage: npx tsx scripts/setup-openrouter-agents.ts
 */
import { getDb } from "../src/memory/store.js";

const dataDir = process.env.DATA_DIR || "./data";
const db = getDb(dataDir);
const now = new Date().toISOString();

// Step 1: Disable old Gemini agents
for (const id of ["gemini", "gemini-2", "gm-dev1"]) {
  db.prepare("UPDATE agents SET enabled = 0, updated_at = ? WHERE id = ?").run(now, id);
}
console.log("✓ Disabled old Gemini agents (gemini, gemini-2, gm-dev1)");

// Step 2: Create 5 OpenRouter agents
const agents = [
  { id: "or01-flash", name: "OR01-Flash", desc: "General chat, messaging, scheduling, memory", provider: "openrouter", model: "google/gemini-2.5-flash" },
  { id: "or02-search", name: "OR02-Search", desc: "Web research, browser, places", provider: "openrouter", model: "deepseek/deepseek-v3.2" },
  { id: "or03-vision", name: "OR03-Vision", desc: "Image analysis/creation, audio/video, TTS", provider: "openrouter", model: "google/gemini-2.5-pro" },
  { id: "or04-dev", name: "OR04-Dev", desc: "Coding, web apps, API integration", provider: "openrouter", model: "deepseek/deepseek-v3.2" },
  { id: "or05-suite", name: "OR05-Suite", desc: "Email, calendar, drive, sheets, writing", provider: "openrouter", model: "openai/gpt-4o-mini" },
];

const insertAgent = db.prepare(`
  INSERT OR REPLACE INTO agents (id, name, description, provider, model, api_key, system_prompt, enabled, is_default, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 0, ?, ?)
`);

for (const a of agents) {
  insertAgent.run(a.id, a.name, a.desc, a.provider, a.model, now, now);
  console.log(`✓ Created ${a.name} (${a.id}) — ${a.provider}/${a.model}`);
}

// Step 3: Assign skills
const skillMap: Record<string, string[]> = {
  "or01-flash": ["general_chat", "messaging", "scheduling", "memory"],
  "or02-search": ["web_research", "browser", "places"],
  "or03-vision": ["image_analysis", "image_creation", "audio_video", "tts"],
  "or04-dev": ["coding", "webapp", "api_integration"],
  "or05-suite": ["email", "calendar_mgmt", "cloud_storage", "spreadsheet", "writing"],
};

const clearSkills = db.prepare("DELETE FROM agent_skills WHERE agent_id = ?");
const insertSkill = db.prepare("INSERT INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");

for (const [agentId, skills] of Object.entries(skillMap)) {
  clearSkills.run(agentId);
  for (const skillId of skills) {
    const priority = skillId === "general_chat" ? 10 : 7;
    insertSkill.run(agentId, skillId, priority);
  }
}
console.log("\n✓ Skills assigned");

// Step 4: Verify
console.log("\n=== All Agents ===");
const allAgents = db.prepare("SELECT id, name, description, provider, model, enabled, is_default FROM agents ORDER BY is_default DESC, enabled DESC, name").all() as any[];
for (const a of allAgents) {
  const skills = db.prepare(
    "SELECT s.id, s.name FROM skills s JOIN agent_skills ask ON ask.skill_id = s.id WHERE ask.agent_id = ? ORDER BY s.name"
  ).all(a.id) as any[];
  const status = a.enabled ? "ON" : "OFF";
  const def = a.is_default ? " DEFAULT" : "";
  console.log(`\n${a.name} (${a.id}) — ${status}${def} — ${a.provider}/${a.model}`);
  console.log(`  ${a.description}`);
  if (skills.length > 0) {
    console.log(`  Skills: ${skills.map((s: any) => s.id).join(", ")}`);
  }
}

// Check uncovered skills
const allSkills = db.prepare("SELECT id, name FROM skills ORDER BY name").all() as any[];
const coveredByEnabled = new Set<string>();
for (const a of allAgents.filter((a: any) => a.enabled)) {
  const skills = db.prepare("SELECT skill_id FROM agent_skills WHERE agent_id = ?").all(a.id) as any[];
  for (const s of skills) coveredByEnabled.add(s.skill_id);
}
const uncovered = allSkills.filter((s: any) => !coveredByEnabled.has(s.id));
console.log("\n=== Skill Coverage ===");
if (uncovered.length) {
  for (const s of uncovered) console.log(`  MISSING: ${s.name} (${s.id})`);
} else {
  console.log("  All skills covered!");
}
