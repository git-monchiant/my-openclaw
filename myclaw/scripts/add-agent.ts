/**
 * Agent management script
 * Usage: npx tsx scripts/add-agent.ts
 */
import { getDb } from "../src/memory/store.js";

const dataDir = process.env.DATA_DIR || "./data";
const db = getDb(dataDir);

// Ensure migration
try { db.exec("ALTER TABLE agents ADD COLUMN api_key TEXT"); } catch { /* exists */ }

const now = new Date().toISOString();

// Rename default gemini → GM01
db.prepare("UPDATE agents SET name = 'GM01', updated_at = ? WHERE id = 'gemini'").run(now);
console.log("Renamed gemini → GM01");

// Rename/update gemini-2 → GM02
db.prepare("UPDATE agents SET name = 'GM02', updated_at = ? WHERE id = 'gemini-2'").run(now);
console.log("Renamed gemini-2 → GM02");

// List all agents
const agents = db.prepare("SELECT id, name, provider, model, api_key, enabled, is_default FROM agents ORDER BY is_default DESC").all() as any[];
console.log("\nAll agents:");
for (const a of agents) {
  const keyLabel = a.api_key ? `***${a.api_key.slice(-4)}` : "(env)";
  console.log(`  ${a.name} (${a.id}) — ${a.provider}/${a.model} — key: ${keyLabel} — ${a.is_default ? "DEFAULT" : a.enabled ? "enabled" : "disabled"}`);
}
