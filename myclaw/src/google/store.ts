/**
 * Google Token Store — Per-user OAuth token storage in SQLite
 * เก็บ encrypted tokens + OAuth state nonces
 */

import crypto from "node:crypto";
import { getDb } from "../memory/store.js";
import { encrypt, decrypt } from "./crypto.js";

let _tablesReady = false;

function ensureTables(dataDir: string): void {
  if (_tablesReady) return;
  const db = getDb(dataDir);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_google_tokens (
      line_user_id TEXT PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      expiry INTEGER,
      scopes TEXT DEFAULT '',
      google_email TEXT,
      default_calendar_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      nonce TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0
    );
  `);

  _tablesReady = true;
}

// ===== Token CRUD =====

export interface UserGoogleTokens {
  lineUserId: string;
  refreshToken: string;
  accessToken: string | null;
  expiry: number | null;
  scopes: string;
  googleEmail: string | null;
  defaultCalendarId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function getUserTokens(dataDir: string, userId: string): UserGoogleTokens | null {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const row = db.prepare("SELECT * FROM user_google_tokens WHERE line_user_id = ?").get(userId) as any;
  if (!row) return null;
  return {
    lineUserId: row.line_user_id,
    refreshToken: decrypt(row.refresh_token),
    accessToken: row.access_token ? decrypt(row.access_token) : null,
    expiry: row.expiry,
    scopes: row.scopes || "",
    googleEmail: row.google_email,
    defaultCalendarId: row.default_calendar_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveUserTokens(dataDir: string, opts: {
  userId: string;
  refreshToken: string;
  accessToken?: string;
  expiry?: number;
  scopes?: string;
  googleEmail?: string;
}): void {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const now = Date.now();

  // Check if exists to preserve created_at and default_calendar_id
  const existing = db.prepare(
    "SELECT created_at, default_calendar_id FROM user_google_tokens WHERE line_user_id = ?",
  ).get(opts.userId) as any;

  db.prepare(`
    INSERT OR REPLACE INTO user_google_tokens
      (line_user_id, refresh_token, access_token, expiry, scopes, google_email, default_calendar_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.userId,
    encrypt(opts.refreshToken),
    opts.accessToken ? encrypt(opts.accessToken) : null,
    opts.expiry ?? null,
    opts.scopes ?? "",
    opts.googleEmail ?? null,
    existing?.default_calendar_id ?? null,
    existing?.created_at ?? now,
    now,
  );
}

export function setDefaultCalendar(dataDir: string, userId: string, calendarId: string): void {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  db.prepare(
    "UPDATE user_google_tokens SET default_calendar_id = ?, updated_at = ? WHERE line_user_id = ?",
  ).run(calendarId, Date.now(), userId);
}

export function getDefaultCalendar(dataDir: string, userId: string): string | null {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const row = db.prepare(
    "SELECT default_calendar_id FROM user_google_tokens WHERE line_user_id = ?",
  ).get(userId) as any;
  return row?.default_calendar_id || null;
}

export function deleteUserTokens(dataDir: string, userId: string): boolean {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const result = db.prepare("DELETE FROM user_google_tokens WHERE line_user_id = ?").run(userId);
  return result.changes > 0;
}

export function isUserLinked(dataDir: string, userId: string): boolean {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const row = db.prepare(
    "SELECT 1 FROM user_google_tokens WHERE line_user_id = ? LIMIT 1",
  ).get(userId);
  return !!row;
}

/** List all linked users (for admin dashboard — no tokens, only metadata) */
export function getAllLinkedUsers(dataDir: string): Array<{
  lineUserId: string;
  googleEmail: string | null;
  defaultCalendarId: string | null;
  createdAt: number;
  updatedAt: number;
}> {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const rows = db.prepare(
    "SELECT line_user_id, google_email, default_calendar_id, created_at, updated_at FROM user_google_tokens ORDER BY updated_at DESC",
  ).all() as any[];
  return rows.map((r) => ({
    lineUserId: r.line_user_id,
    googleEmail: r.google_email,
    defaultCalendarId: r.default_calendar_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ===== OAuth State (nonce) =====

export function createOAuthState(dataDir: string, userId: string): string {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const nonce = crypto.randomBytes(32).toString("hex");

  // Cleanup expired states (> 30 min)
  const cutoff = Date.now() - 30 * 60 * 1000;
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(cutoff);

  db.prepare(
    "INSERT INTO oauth_states (nonce, line_user_id, created_at, used) VALUES (?, ?, ?, 0)",
  ).run(nonce, userId, Date.now());

  return nonce;
}

export function consumeOAuthState(dataDir: string, nonce: string): string | null {
  ensureTables(dataDir);
  const db = getDb(dataDir);
  const row = db.prepare(
    "SELECT * FROM oauth_states WHERE nonce = ? AND used = 0",
  ).get(nonce) as any;

  if (!row) return null;

  // Mark as used immediately
  db.prepare("UPDATE oauth_states SET used = 1 WHERE nonce = ?").run(nonce);

  // Check expiry (10 minutes)
  if (Date.now() - row.created_at > 10 * 60 * 1000) {
    return null;
  }

  return row.line_user_id;
}
