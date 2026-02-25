/**
 * Disable GM01-Default
 * Usage: npx tsx scripts/disable-gm01.ts
 */
import { getDb } from "../src/memory/store.js";

const dataDir = process.env.DATA_DIR || "./data";
const db = getDb(dataDir);
const now = new Date().toISOString();

db.prepare("UPDATE agents SET enabled = 0, updated_at = ? WHERE id = 'gemini'").run(now);
console.log("GM01-Default disabled");

// Verify
const agents = db.prepare("SELECT id, name, enabled, is_default FROM agents ORDER BY is_default DESC, name").all() as any[];
for (const a of agents) {
  console.log(`  ${a.name} — ${a.enabled ? 'enabled' : 'DISABLED'} ${a.is_default ? '(default)' : ''}`);
}
