/**
 * Check skill coverage across agents
 * Usage: npx tsx scripts/check-skills.ts
 */
import { getDb } from "../src/memory/store.js";

const db = getDb(process.env.DATA_DIR || "./data");

// All agents with skills
const agents = db.prepare("SELECT id, name, enabled, is_default FROM agents ORDER BY is_default DESC, name").all() as any[];
console.log("=== Agents ===");
for (const a of agents) {
  const skills = db.prepare(
    "SELECT s.id, s.name, s.tool_type FROM skills s JOIN agent_skills ask ON ask.skill_id = s.id WHERE ask.agent_id = ? ORDER BY s.name"
  ).all(a.id) as any[];
  const status = a.enabled ? "ON" : "OFF";
  console.log(`\n${a.name} (${a.id}) — ${status}${a.is_default ? " DEFAULT" : ""}`);
  for (const s of skills) console.log(`  ${s.tool_type === "ai" ? "[AI]   " : "[non-ai]"} ${s.name}`);
}

// Check uncovered skills
const allSkills = db.prepare("SELECT id, name FROM skills ORDER BY name").all() as any[];
const coveredByEnabled = new Set<string>();
for (const a of agents.filter((a: any) => a.enabled)) {
  const skills = db.prepare("SELECT skill_id FROM agent_skills WHERE agent_id = ?").all(a.id) as any[];
  for (const s of skills) coveredByEnabled.add(s.skill_id);
}
const uncovered = allSkills.filter((s: any) => !coveredByEnabled.has(s.id));
console.log("\n=== Uncovered skills (no enabled agent) ===");
if (uncovered.length) {
  for (const s of uncovered) console.log(`  MISSING: ${s.name} (${s.id})`);
} else {
  console.log("  All skills covered!");
}
