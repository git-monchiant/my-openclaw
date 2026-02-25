/**
 * User Profile Store — Per-user key-value preferences in SQLite
 * Inspired by OpenClaw's USER.md but using structured DB storage
 */

import { getDb } from "../memory/store.js";

let _tableReady = false;

function ensureTable(dataDir: string): void {
  if (_tableReady) return;
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_profiles_user
      ON user_profiles(user_id);
  `);
  _tableReady = true;
}

/** Get all profile fields for a user */
export function getUserProfile(dataDir: string, userId: string): Record<string, string> {
  ensureTable(dataDir);
  const db = getDb(dataDir);
  const rows = db
    .prepare("SELECT key, value FROM user_profiles WHERE user_id = ? ORDER BY key")
    .all(userId) as Array<{ key: string; value: string }>;
  const profile: Record<string, string> = {};
  for (const row of rows) {
    profile[row.key] = row.value;
  }
  return profile;
}

/** Get a single profile field */
export function getProfileField(dataDir: string, userId: string, key: string): string | null {
  ensureTable(dataDir);
  const db = getDb(dataDir);
  const row = db
    .prepare("SELECT value FROM user_profiles WHERE user_id = ? AND key = ?")
    .get(userId, key.toLowerCase().trim()) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Set (upsert) a profile field */
export function setProfileField(dataDir: string, userId: string, key: string, value: string): void {
  ensureTable(dataDir);
  const db = getDb(dataDir);
  const normalizedKey = key.toLowerCase().trim();
  const trimmedValue = value.trim();
  if (!normalizedKey || !trimmedValue) return;
  db.prepare(`
    INSERT OR REPLACE INTO user_profiles (user_id, key, value, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, normalizedKey, trimmedValue, Date.now());
}

/** Delete a profile field */
export function deleteProfileField(dataDir: string, userId: string, key: string): boolean {
  ensureTable(dataDir);
  const db = getDb(dataDir);
  const result = db
    .prepare("DELETE FROM user_profiles WHERE user_id = ? AND key = ?")
    .run(userId, key.toLowerCase().trim());
  return result.changes > 0;
}

/** Format profile as compact prompt snippet (max ~500 chars) */
export function formatProfileForPrompt(dataDir: string, userId: string): string {
  const profile = getUserProfile(dataDir, userId);
  const keys = Object.keys(profile);
  if (keys.length === 0) return "";

  // Well-known fields first, then custom
  const knownOrder = ["name", "nickname", "language", "timezone", "notes"];
  const known = knownOrder.filter((k) => profile[k]);
  const custom = keys.filter((k) => !knownOrder.includes(k)).sort();

  const lines: string[] = [];
  for (const k of [...known, ...custom]) {
    const label = k.charAt(0).toUpperCase() + k.slice(1);
    lines.push(`- ${label}: ${profile[k]}`);
  }

  let result = lines.join("\n");

  // Cap at ~500 chars
  if (result.length > 500) {
    // Truncate notes first if present
    const notesIdx = lines.findIndex((l) => l.startsWith("- Notes:"));
    if (notesIdx >= 0 && lines[notesIdx].length > 100) {
      lines[notesIdx] = lines[notesIdx].substring(0, 100) + "...";
      result = lines.join("\n");
    }
    // If still over, drop custom fields from the end
    while (result.length > 500 && lines.length > known.length) {
      lines.pop();
      result = lines.join("\n");
    }
  }

  return result;
}
