/**
 * Add gm-dev1 agent — same role as GM01 (Google + Research)
 * Usage: npx tsx scripts/add-gm-dev1.ts
 */
import { getDb } from "../src/memory/store.js";

const dataDir = process.env.DATA_DIR || "./data";
const db = getDb(dataDir);

const now = new Date().toISOString();
const API_KEY = "AIzaSyDMO8tkHyodEBt12mx3klEp-ZYjTj_tlgU";

// Ensure api_key column exists
try { db.exec("ALTER TABLE agents ADD COLUMN api_key TEXT"); } catch { /* exists */ }

// Check if already exists
const existing = db.prepare("SELECT id FROM agents WHERE id = 'gm-dev1'").get();
if (existing) {
  console.log("gm-dev1 already exists, updating...");
  db.prepare("UPDATE agents SET api_key = ?, updated_at = ? WHERE id = 'gm-dev1'").run(API_KEY, now);
} else {
  // Create agent
  db.prepare(`
    INSERT INTO agents (id, name, description, provider, model, api_key, system_prompt, enabled, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 0, ?, ?)
  `).run("gm-dev1", "gm-dev1", "Google services, web research, memory, scheduling (dev key)", "gemini", "gemini-2.5-flash", API_KEY, now, now);
  console.log("Created agent gm-dev1");
}

// Assign same skills as GM01
const GM01_SKILLS = [
  "general_chat", "web_research", "memory", "scheduling", "messaging",
  "email", "calendar_mgmt", "cloud_storage", "spreadsheet",
];

db.prepare("DELETE FROM agent_skills WHERE agent_id = 'gm-dev1'").run();
const insert = db.prepare("INSERT INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)");
for (const skillId of GM01_SKILLS) {
  insert.run("gm-dev1", skillId, skillId === "general_chat" ? 10 : 5);
}
console.log(`Assigned ${GM01_SKILLS.length} skills (same as GM01)`);

// Verify all agents
console.log("\n===== All Agents =====");
const agents = db.prepare("SELECT id, name, description, provider, model, api_key, enabled, is_default FROM agents ORDER BY is_default DESC, name").all() as any[];
for (const a of agents) {
  const skills = db.prepare(
    "SELECT s.name FROM skills s JOIN agent_skills ask ON ask.skill_id = s.id WHERE ask.agent_id = ? ORDER BY s.name"
  ).all(a.id) as any[];
  const keyLabel = a.api_key ? `***${a.api_key.slice(-4)}` : "(env)";
  console.log(`\n${a.name} (${a.id}) — ${a.provider}/${a.model} — key: ${keyLabel} — ${a.is_default ? "DEFAULT" : a.enabled ? "enabled" : "disabled"}`);
  console.log(`  ${a.description}`);
  console.log(`  Skills: ${skills.map((s: any) => s.name).join(", ")}`);
}
