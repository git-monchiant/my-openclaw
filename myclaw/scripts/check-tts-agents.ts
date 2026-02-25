import { getDb } from "../src/memory/store.js";

const db = getDb(process.env.DATA_DIR || "./data");
const rows = db.prepare(`
  SELECT a.id, a.name, a.model, ask.skill_id, ask.priority
  FROM agents a
  JOIN agent_skills ask ON ask.agent_id = a.id
  WHERE ask.skill_id = 'tts' AND a.enabled = 1
  ORDER BY ask.priority DESC
`).all() as any[];

console.log("Agents with TTS skill:");
rows.forEach((r: any) => console.log(`  ${r.id} (${r.name}) — model: ${r.model} — priority: ${r.priority}`));

if (!rows.length) {
  console.log("  (none!)");
}
