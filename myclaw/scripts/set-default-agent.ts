/**
 * Set OR01-Flash as default agent
 * Usage: npx tsx scripts/set-default-agent.ts
 */
import { getDb } from "../src/memory/store.js";

const db = getDb(process.env.DATA_DIR || "./data");
const now = new Date().toISOString();

db.prepare("UPDATE agents SET is_default = 0").run();
db.prepare("UPDATE agents SET is_default = 1, updated_at = ? WHERE id = ?").run(now, "or01-flash");

const def = db.prepare("SELECT id, name, is_default, enabled FROM agents WHERE is_default = 1").get() as any;
console.log(`✓ Set default agent: ${def.name} (${def.id}) — enabled: ${def.enabled}`);
