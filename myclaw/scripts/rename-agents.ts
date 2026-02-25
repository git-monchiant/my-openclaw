/**
 * Rename agents: GM01-Default, GM02-PS, GM03-Dev1
 * Usage: npx tsx scripts/rename-agents.ts
 */
import { getDb } from "../src/memory/store.js";

const dataDir = process.env.DATA_DIR || "./data";
const db = getDb(dataDir);
const now = new Date().toISOString();

db.prepare("UPDATE agents SET name = 'GM01-Default', updated_at = ? WHERE id = 'gemini'").run(now);
db.prepare("UPDATE agents SET name = 'GM02-PS', updated_at = ? WHERE id = 'gemini-2'").run(now);
db.prepare("UPDATE agents SET name = 'GM03-Dev1', updated_at = ? WHERE id = 'gm-dev1'").run(now);

// Verify
const agents = db.prepare("SELECT id, name, description, api_key, is_default FROM agents ORDER BY is_default DESC, name").all() as any[];
console.log("Renamed agents:\n");
for (const a of agents) {
  const keyLabel = a.api_key ? `***${a.api_key.slice(-4)}` : "(env)";
  console.log(`  ${a.name} (${a.id}) — key: ${keyLabel} — ${a.is_default ? "DEFAULT" : "enabled"}`);
  console.log(`    ${a.description}`);
}
