/**
 * Split skills between GM01 and GM02
 * GM01 = Google + Research (default)
 * GM02 = Tools + Media
 *
 * Usage: npx tsx scripts/split-skills.ts
 */
import { getDb } from "../src/memory/store.js";

const dataDir = process.env.DATA_DIR || "./data";
const db = getDb(dataDir);

// ===== Define skill assignments =====
const GM01_SKILLS = [
  "general_chat", "web_research", "memory", "scheduling", "messaging",
  "email", "calendar_mgmt", "cloud_storage", "spreadsheet",
];

const GM02_SKILLS = [
  "image_analysis", "image_creation", "audio_video", "tts",
  "coding", "writing", "webapp", "browser", "places", "api_integration",
];

// ===== Clear existing assignments =====
db.prepare("DELETE FROM agent_skills WHERE agent_id = 'gemini'").run();
db.prepare("DELETE FROM agent_skills WHERE agent_id = 'gemini-2'").run();
console.log("Cleared existing skill assignments");

// ===== Assign GM01 skills =====
const insert = db.prepare("INSERT INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");
for (const skillId of GM01_SKILLS) {
  insert.run("gemini", skillId, skillId === "general_chat" ? 10 : 5);
}
console.log(`GM01: assigned ${GM01_SKILLS.length} skills — ${GM01_SKILLS.join(", ")}`);

// ===== Assign GM02 skills =====
for (const skillId of GM02_SKILLS) {
  insert.run("gemini-2", skillId, 5);
}
console.log(`GM02: assigned ${GM02_SKILLS.length} skills — ${GM02_SKILLS.join(", ")}`);

// ===== Update descriptions =====
const now = new Date().toISOString();
db.prepare("UPDATE agents SET description = ?, updated_at = ? WHERE id = 'gemini'")
  .run("Google services, web research, memory, scheduling", now);
db.prepare("UPDATE agents SET description = ?, updated_at = ? WHERE id = 'gemini-2'")
  .run("Media, creative tools, coding, web apps", now);

// ===== Verify =====
console.log("\n===== Verification =====");
const agents = db.prepare("SELECT id, name, description FROM agents ORDER BY is_default DESC").all() as any[];
for (const a of agents) {
  const skills = db.prepare(
    "SELECT s.name, ask.priority FROM skills s JOIN agent_skills ask ON ask.skill_id = s.id WHERE ask.agent_id = ? ORDER BY ask.priority DESC, s.name"
  ).all(a.id) as any[];
  console.log(`\n${a.name} (${a.id}) — ${a.description}`);
  for (const s of skills) {
    console.log(`  - ${s.name} (p${s.priority})`);
  }
}
