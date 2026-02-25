/**
 * Swap skills: GM03-Dev1 → Tools+Media, GM02-PS → Google+Research
 * Usage: npx tsx scripts/swap-skills.ts
 */
import { getDb } from "../src/memory/store.js";

const db = getDb(process.env.DATA_DIR || "./data");
const now = new Date().toISOString();

const GOOGLE_RESEARCH = [
  "general_chat", "web_research", "memory", "scheduling", "messaging",
  "email", "calendar_mgmt", "cloud_storage", "spreadsheet",
];

const TOOLS_MEDIA = [
  "image_analysis", "image_creation", "audio_video", "tts",
  "coding", "writing", "webapp", "browser", "places", "api_integration",
];

// Clear both
db.prepare("DELETE FROM agent_skills WHERE agent_id = 'gemini-2'").run();
db.prepare("DELETE FROM agent_skills WHERE agent_id = 'gm-dev1'").run();

const insert = db.prepare("INSERT INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");

// GM02-PS → Google+Research
for (const s of GOOGLE_RESEARCH) insert.run("gemini-2", s, s === "general_chat" ? 10 : 5);
db.prepare("UPDATE agents SET description = 'Google services, web research, memory, scheduling', updated_at = ? WHERE id = 'gemini-2'").run(now);

// GM03-Dev1 → Tools+Media
for (const s of TOOLS_MEDIA) insert.run("gm-dev1", s, 5);
db.prepare("UPDATE agents SET description = 'Media, creative tools, coding, web apps', updated_at = ? WHERE id = 'gm-dev1'").run(now);

// Verify
const agents = db.prepare("SELECT id, name, description, enabled FROM agents ORDER BY is_default DESC, name").all() as any[];
for (const a of agents) {
  const skills = db.prepare(
    "SELECT s.name, s.tool_type FROM skills s JOIN agent_skills ask ON ask.skill_id = s.id WHERE ask.agent_id = ? ORDER BY s.name"
  ).all(a.id) as any[];
  console.log(`\n${a.name} — ${a.enabled ? "ON" : "OFF"} — ${a.description}`);
  for (const s of skills) console.log(`  ${s.name} [${s.tool_type}]`);
}
