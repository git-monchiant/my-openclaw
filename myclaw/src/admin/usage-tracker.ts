/**
 * Usage Tracker — monitor Gemini API + LINE push usage
 *
 * ใช้ free tier limits เป็นตัววัด (คอยดูว่าเกินฟรีหรือยัง):
 *   gemini-2.5-flash: 10 RPM, 250 RPD, 250K TPM
 *   gemini-embedding-001: 10 RPM, 250 RPD, 250K TPM
 *
 * LINE Messaging API free plan:
 *   300 push messages / month (configurable via LINE_PUSH_LIMIT env)
 *
 * Reset: RPD resets at midnight Pacific, LINE resets monthly
 */

import { emitDashboardEvent } from "./events.js";
import { getDb } from "../memory/store.js";

// ===== Types =====
interface GeminiCall {
  ts: number;
  endpoint: string; // chat, embed, image, search, tts, spawn
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  error: boolean;
  status: number;
  agentId: string; // "orchestrator" | agent id (e.g. "gemini", "gemini-2")
}

interface LinePushCall {
  ts: number;
  userId: string;
  source: string; // reply, push, cron, spawn, message, canvas, nodes, send
}

interface WebhookCall {
  ts: number;
  userId: string;
  eventType: string; // text, image, sticker, etc.
}

// ===== Storage (in-memory, rolling window) =====
const MAX_HISTORY = 2000;
const geminiCalls: GeminiCall[] = [];
const linePushCalls: LinePushCall[] = [];
const webhookCalls: WebhookCall[] = [];

// ===== SQLite persistence (immediate write) =====
let _dataDir: string | null = null;

// ===== Gemini Limits (free tier — ไว้คอยดูว่าเกินฟรีหรือยัง) =====
const GEMINI_LIMITS = {
  RPM: 10,
  RPD: 250,
  TPM: 250_000,
};

// ===== Track Gemini API call =====
export function trackGemini(params: {
  endpoint: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  status?: number;
  error?: boolean;
  agentId?: string;
}): void {
  const call: GeminiCall = {
    ts: Date.now(),
    endpoint: params.endpoint,
    model: params.model || "unknown",
    promptTokens: params.promptTokens || 0,
    completionTokens: params.completionTokens || 0,
    totalTokens: params.totalTokens || 0,
    error: params.error || false,
    status: params.status || 200,
    agentId: params.agentId || "orchestrator",
  };
  geminiCalls.push(call);
  if (geminiCalls.length > MAX_HISTORY) geminiCalls.splice(0, geminiCalls.length - MAX_HISTORY);
  persistApiCall(call);
  emitDashboardEvent("gemini_call", {
    endpoint: call.endpoint, model: call.model, tokens: call.totalTokens,
    error: call.error, status: call.status, agentId: call.agentId,
  });
}

// ===== Track LINE push =====
export function trackLinePush(userId: string, source: string): void {
  const call: LinePushCall = { ts: Date.now(), userId, source };
  linePushCalls.push(call);
  if (linePushCalls.length > MAX_HISTORY) linePushCalls.splice(0, linePushCalls.length - MAX_HISTORY);
  persistPushCall(call);
  emitDashboardEvent("line_push", { userId: userId.substring(0, 8), source });
}

// ===== Query helpers =====
function callsSince(calls: Array<{ ts: number }>, ms: number): number {
  const cutoff = Date.now() - ms;
  return calls.filter((c) => c.ts >= cutoff).length;
}

function tokensSince(calls: GeminiCall[], ms: number, field: keyof GeminiCall): number {
  const cutoff = Date.now() - ms;
  return calls.filter((c) => c.ts >= cutoff).reduce((sum, c) => sum + (c[field] as number), 0);
}

// Midnight Pacific Time → ms until reset
function getMidnightPacificMs(): number {
  const now = new Date();
  // Pacific time = UTC-8 (PST) or UTC-7 (PDT)
  // Approximate: use fixed -8 offset
  const pacificOffset = -8 * 60;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const pacificMs = utcMs + pacificOffset * 60_000;
  const pacificDate = new Date(pacificMs);

  const midnight = new Date(pacificDate);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);

  return midnight.getTime() - pacificDate.getTime();
}

// Calls since midnight Pacific
function callsSinceMidnightPacific(calls: Array<{ ts: number }>): number {
  const now = new Date();
  const pacificOffset = -8 * 60;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const pacificMs = utcMs + pacificOffset * 60_000;
  const pacificDate = new Date(pacificMs);

  const midnight = new Date(pacificDate);
  midnight.setHours(0, 0, 0, 0);

  // Convert back to local timestamp
  const midnightLocal = midnight.getTime() - pacificOffset * 60_000 - now.getTimezoneOffset() * 60_000;

  return calls.filter((c) => c.ts >= midnightLocal).length;
}

// Calls this month (for LINE push)
function callsThisMonth(calls: Array<{ ts: number }>): number {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return calls.filter((c) => c.ts >= firstOfMonth).length;
}

// ===== Get usage stats =====
export function getGeminiUsage() {
  const rpm = callsSince(geminiCalls, 60_000);
  const rpd = callsSinceMidnightPacific(geminiCalls);
  const tpm = tokensSince(geminiCalls, 60_000, "totalTokens");
  const errors = geminiCalls.filter((c) => c.error);
  const rateLimits = errors.filter((c) => c.status === 429);

  // Per-endpoint breakdown
  const byEndpoint: Record<string, number> = {};
  for (const c of geminiCalls) {
    byEndpoint[c.endpoint] = (byEndpoint[c.endpoint] || 0) + 1;
  }

  // Token totals
  const totalPromptTokens = geminiCalls.reduce((s, c) => s + c.promptTokens, 0);
  const totalCompletionTokens = geminiCalls.reduce((s, c) => s + c.completionTokens, 0);

  // Recent calls (last 20)
  const recent = geminiCalls.slice(-20).reverse().map((c) => ({
    time: new Date(c.ts).toISOString(),
    endpoint: c.endpoint,
    model: c.model,
    tokens: c.totalTokens,
    error: c.error,
    status: c.status,
    agentId: c.agentId,
  }));

  return {
    limits: GEMINI_LIMITS,
    current: {
      rpm,
      rpmPct: Math.round((rpm / GEMINI_LIMITS.RPM) * 100),
      rpd,
      rpdPct: Math.round((rpd / GEMINI_LIMITS.RPD) * 100),
      tpm,
      tpmPct: Math.round((tpm / GEMINI_LIMITS.TPM) * 100),
    },
    remaining: {
      rpm: Math.max(0, GEMINI_LIMITS.RPM - rpm),
      rpd: Math.max(0, GEMINI_LIMITS.RPD - rpd),
      tpm: Math.max(0, GEMINI_LIMITS.TPM - tpm),
    },
    resetIn: {
      rpmSeconds: 60 - (Date.now() % 60_000) / 1000,
      rpdHours: Math.round(getMidnightPacificMs() / 3_600_000 * 10) / 10,
    },
    totals: {
      requests: geminiCalls.length,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      errors: errors.length,
      rateLimits: rateLimits.length,
    },
    byEndpoint,
    recent,
  };
}

// ===== Track LINE webhook =====
export function trackWebhook(userId: string, eventType: string): void {
  const call: WebhookCall = { ts: Date.now(), userId, eventType };
  webhookCalls.push(call);
  if (webhookCalls.length > MAX_HISTORY) webhookCalls.splice(0, webhookCalls.length - MAX_HISTORY);
  persistWebhookCall(call);
  emitDashboardEvent("webhook", { userId: userId.substring(0, 8), eventType });
}

export function getWebhookStats() {
  const rpm = callsSince(webhookCalls, 60_000);
  const today = callsSince(webhookCalls, 86_400_000);

  // Per-type breakdown
  const byType: Record<string, number> = {};
  for (const c of webhookCalls) {
    byType[c.eventType] = (byType[c.eventType] || 0) + 1;
  }

  // Recent (last 20)
  const recent = webhookCalls.slice(-20).reverse().map((c) => ({
    time: new Date(c.ts).toISOString(),
    userId: c.userId.substring(0, 8) + "...",
    eventType: c.eventType,
  }));

  return { rpm, today, total: webhookCalls.length, byType, recent };
}

// ===== Per-agent usage stats =====
export function getAgentUsage(agentId?: string) {
  const filtered = agentId
    ? geminiCalls.filter((c) => c.agentId === agentId)
    : geminiCalls;

  const rpm = callsSince(filtered, 60_000);
  const rpd = callsSinceMidnightPacific(filtered);
  const tpm = tokensSince(filtered, 60_000, "totalTokens");
  const errors = filtered.filter((c) => c.error);

  const totalPromptTokens = filtered.reduce((s, c) => s + c.promptTokens, 0);
  const totalCompletionTokens = filtered.reduce((s, c) => s + c.completionTokens, 0);

  // Per-endpoint breakdown
  const byEndpoint: Record<string, number> = {};
  for (const c of filtered) {
    byEndpoint[c.endpoint] = (byEndpoint[c.endpoint] || 0) + 1;
  }

  // Recent calls (last 20)
  const recent = filtered.slice(-20).reverse().map((c) => ({
    time: new Date(c.ts).toISOString(),
    endpoint: c.endpoint,
    model: c.model,
    tokens: c.totalTokens,
    error: c.error,
    status: c.status,
  }));

  return {
    agentId: agentId || "all",
    limits: GEMINI_LIMITS,
    current: {
      rpm,
      rpmPct: Math.round((rpm / GEMINI_LIMITS.RPM) * 100),
      rpd,
      rpdPct: Math.round((rpd / GEMINI_LIMITS.RPD) * 100),
      tpm,
      tpmPct: Math.round((tpm / GEMINI_LIMITS.TPM) * 100),
    },
    totals: {
      requests: filtered.length,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      errors: errors.length,
      rateLimits: errors.filter((c) => c.status === 429).length,
    },
    byEndpoint,
    recent,
  };
}

/** Get usage breakdown for all agents */
export function getAllAgentsUsage() {
  const agentIds = new Set(geminiCalls.map((c) => c.agentId));
  const agents: Record<string, ReturnType<typeof getAgentUsage>> = {};
  for (const id of agentIds) {
    agents[id] = getAgentUsage(id);
  }
  return agents;
}

export function getLinePushUsage() {
  const limit = Number(process.env.LINE_PUSH_LIMIT) || 300;

  // Read from DB (accurate even after restart)
  let thisMonth = 0;
  let today = 0;
  let total = 0;
  const bySource: Record<string, number> = {};
  let recent: Array<{ time: string; userId: string; source: string }> = [];

  if (_dataDir) {
    try {
      const db = getDb(_dataDir);
      const now = new Date();
      const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      thisMonth = (db.prepare("SELECT COUNT(*) as cnt FROM usage_line_push WHERE ts >= ?").get(firstOfMonth) as any).cnt;
      today = (db.prepare("SELECT COUNT(*) as cnt FROM usage_line_push WHERE ts >= ?").get(startOfDay) as any).cnt;
      total = (db.prepare("SELECT COUNT(*) as cnt FROM usage_line_push").get() as any).cnt;

      const sources = db.prepare("SELECT source, COUNT(*) as cnt FROM usage_line_push WHERE ts >= ? GROUP BY source").all(firstOfMonth) as Array<{ source: string; cnt: number }>;
      for (const s of sources) bySource[s.source] = s.cnt;

      recent = (db.prepare("SELECT ts, user_id, source FROM usage_line_push ORDER BY ts DESC LIMIT 10").all() as Array<{ ts: number; user_id: string; source: string }>)
        .map((c) => ({ time: new Date(c.ts).toISOString(), userId: c.user_id.substring(0, 8) + "...", source: c.source }));
    } catch {
      // Fallback to in-memory
      thisMonth = callsThisMonth(linePushCalls);
      today = callsSince(linePushCalls, 86_400_000);
      total = linePushCalls.length;
      for (const c of linePushCalls) bySource[c.source] = (bySource[c.source] || 0) + 1;
      recent = linePushCalls.slice(-10).reverse().map((c) => ({
        time: new Date(c.ts).toISOString(), userId: c.userId.substring(0, 8) + "...", source: c.source,
      }));
    }
  } else {
    thisMonth = callsThisMonth(linePushCalls);
    today = callsSince(linePushCalls, 86_400_000);
    total = linePushCalls.length;
    for (const c of linePushCalls) bySource[c.source] = (bySource[c.source] || 0) + 1;
    recent = linePushCalls.slice(-10).reverse().map((c) => ({
      time: new Date(c.ts).toISOString(), userId: c.userId.substring(0, 8) + "...", source: c.source,
    }));
  }

  return {
    limit,
    thisMonth,
    remaining: Math.max(0, limit - thisMonth),
    pct: Math.round((thisMonth / limit) * 100),
    today,
    total,
    bySource,
    recent,
  };
}

// ===== SQLite Persistence =====

function ensureUsageTables(dataDir: string): void {
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      error INTEGER DEFAULT 0,
      status INTEGER DEFAULT 200,
      agent_id TEXT DEFAULT 'orchestrator'
    );
    CREATE INDEX IF NOT EXISTS idx_usage_api_ts ON usage_api_calls(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_api_agent ON usage_api_calls(agent_id, ts);

    CREATE TABLE IF NOT EXISTS usage_line_push (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_push_ts ON usage_line_push(ts);

    CREATE TABLE IF NOT EXISTS usage_webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_webhook_ts ON usage_webhooks(ts);

    CREATE TABLE IF NOT EXISTS usage_daily (
      date TEXT NOT NULL,
      metric TEXT NOT NULL,
      agent_id TEXT DEFAULT 'all',
      value INTEGER DEFAULT 0,
      PRIMARY KEY (date, metric, agent_id)
    );
  `);
}

// ===== Immediate DB persistence =====
function persistApiCall(c: GeminiCall): void {
  if (!_dataDir) return;
  try {
    const db = getDb(_dataDir);
    const today = new Date(c.ts).toISOString().substring(0, 10);
    db.prepare(
      `INSERT INTO usage_api_calls (ts, endpoint, model, provider, prompt_tokens, completion_tokens, total_tokens, error, status, agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.ts, c.endpoint, c.model, "gemini", c.promptTokens, c.completionTokens, c.totalTokens, c.error ? 1 : 0, c.status, c.agentId);
    db.prepare(`INSERT INTO usage_daily (date, metric, agent_id, value) VALUES (?, 'api_calls', 'all', 1)
      ON CONFLICT(date, metric, agent_id) DO UPDATE SET value = value + 1`).run(today);
    db.prepare(`INSERT INTO usage_daily (date, metric, agent_id, value) VALUES (?, 'tokens', 'all', ?)
      ON CONFLICT(date, metric, agent_id) DO UPDATE SET value = value + excluded.value`).run(today, c.totalTokens);
    if (c.error) {
      db.prepare(`INSERT INTO usage_daily (date, metric, agent_id, value) VALUES (?, 'errors', 'all', 1)
        ON CONFLICT(date, metric, agent_id) DO UPDATE SET value = value + 1`).run(today);
    }
  } catch (err: any) {
    console.error(`[USAGE] persistApiCall failed: ${err?.message}`);
  }
}

function persistPushCall(c: LinePushCall): void {
  if (!_dataDir) return;
  try {
    const db = getDb(_dataDir);
    const today = new Date(c.ts).toISOString().substring(0, 10);
    db.prepare(`INSERT INTO usage_line_push (ts, user_id, source) VALUES (?, ?, ?)`).run(c.ts, c.userId, c.source);
    db.prepare(`INSERT INTO usage_daily (date, metric, agent_id, value) VALUES (?, 'line_push', 'all', 1)
      ON CONFLICT(date, metric, agent_id) DO UPDATE SET value = value + 1`).run(today);
  } catch (err: any) {
    console.error(`[USAGE] persistPushCall failed: ${err?.message}`);
  }
}

function persistWebhookCall(c: WebhookCall): void {
  if (!_dataDir) return;
  try {
    const db = getDb(_dataDir);
    const today = new Date(c.ts).toISOString().substring(0, 10);
    db.prepare(`INSERT INTO usage_webhooks (ts, user_id, event_type) VALUES (?, ?, ?)`).run(c.ts, c.userId, c.eventType);
    db.prepare(`INSERT INTO usage_daily (date, metric, agent_id, value) VALUES (?, 'webhooks', 'all', 1)
      ON CONFLICT(date, metric, agent_id) DO UPDATE SET value = value + 1`).run(today);
  } catch (err: any) {
    console.error(`[USAGE] persistWebhookCall failed: ${err?.message}`);
  }
}

function cleanupOldData(dataDir: string): void {
  try {
    const db = getDb(dataDir);
    const cutoff = Date.now() - 90 * 86_400_000; // 90 days
    db.prepare("DELETE FROM usage_api_calls WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM usage_line_push WHERE ts < ?").run(cutoff);
    db.prepare("DELETE FROM usage_webhooks WHERE ts < ?").run(cutoff);
    const cutoffDate = new Date(cutoff).toISOString().substring(0, 10);
    db.prepare("DELETE FROM usage_daily WHERE date < ?").run(cutoffDate);
  } catch {
    // Tables may not exist yet on first run
  }
}

/** Initialize persistent usage tracking — call once from admin router setup */
export function initUsageTracker(dataDir: string): void {
  if (_dataDir) return; // Already initialized
  _dataDir = dataDir;

  try {
    ensureUsageTables(dataDir);
    cleanupOldData(dataDir);
    console.log("[USAGE] Persistent tracking initialized (immediate write)");
  } catch (err: any) {
    console.error(`[USAGE] Init failed: ${err?.message}`);
  }
}

/** Get daily usage history for charts */
export function getUsageHistory(days = 30, metric = "api_calls"): Array<{ date: string; value: number }> {
  if (!_dataDir) return [];
  try {
    const db = getDb(_dataDir);
    const cutoffDate = new Date(Date.now() - days * 86_400_000).toISOString().substring(0, 10);
    return db.prepare(
      "SELECT date, value FROM usage_daily WHERE metric = ? AND agent_id = 'all' AND date >= ? ORDER BY date ASC",
    ).all(metric, cutoffDate) as Array<{ date: string; value: number }>;
  } catch {
    return [];
  }
}
