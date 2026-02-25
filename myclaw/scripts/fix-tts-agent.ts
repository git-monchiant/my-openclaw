/**
 * Give TTS skill to or01-flash (cheapest model) with highest priority
 * so TTS requests go to the cheap agent instead of expensive gemini-2.5-pro
 */
import { getDb } from "../src/memory/store.js";

const db = getDb(process.env.DATA_DIR || "./data");

// Check current state
const current = db.prepare(`
  SELECT a.id, a.name, a.model, ask.priority
  FROM agents a
  JOIN agent_skills ask ON ask.agent_id = a.id
  WHERE ask.skill_id = 'tts' AND a.enabled = 1
  ORDER BY ask.priority DESC
`).all() as any[];

console.log("Before:");
current.forEach((r: any) => console.log(`  ${r.id} (${r.name}) — ${r.model} — priority: ${r.priority}`));

// Add tts to or01-flash with priority 10 (highest)
const exists = db.prepare("SELECT 1 FROM agent_skills WHERE agent_id = ? AND skill_id = ?").get("or01-flash", "tts");
if (exists) {
  db.prepare("UPDATE agent_skills SET priority = 10 WHERE agent_id = ? AND skill_id = ?").run("or01-flash", "tts");
  console.log("\n✓ Updated or01-flash tts priority to 10");
} else {
  db.prepare("INSERT INTO agent_skills (agent_id, skill_id, priority) VALUES (?, ?, ?)").run("or01-flash", "tts", 10);
  console.log("\n✓ Added tts skill to or01-flash with priority 10");
}

// Verify
const after = db.prepare(`
  SELECT a.id, a.name, a.model, ask.priority
  FROM agents a
  JOIN agent_skills ask ON ask.agent_id = a.id
  WHERE ask.skill_id = 'tts' AND a.enabled = 1
  ORDER BY ask.priority DESC
`).all() as any[];

console.log("\nAfter:");
after.forEach((r: any) => console.log(`  ${r.id} (${r.name}) — ${r.model} — priority: ${r.priority}`));
console.log("\n→ TTS will now route to: " + after[0]?.name + " (" + after[0]?.model + ")");
