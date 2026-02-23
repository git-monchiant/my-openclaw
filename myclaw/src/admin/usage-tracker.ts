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
}

interface LinePushCall {
  ts: number;
  userId: string;
  source: string; // reply, push, cron, spawn, message, canvas, nodes, send
}

// ===== Storage (in-memory, rolling window) =====
const MAX_HISTORY = 2000;
const geminiCalls: GeminiCall[] = [];
const linePushCalls: LinePushCall[] = [];

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
}): void {
  geminiCalls.push({
    ts: Date.now(),
    endpoint: params.endpoint,
    model: params.model || "unknown",
    promptTokens: params.promptTokens || 0,
    completionTokens: params.completionTokens || 0,
    totalTokens: params.totalTokens || 0,
    error: params.error || false,
    status: params.status || 200,
  });
  if (geminiCalls.length > MAX_HISTORY) geminiCalls.splice(0, geminiCalls.length - MAX_HISTORY);
}

// ===== Track LINE push =====
export function trackLinePush(userId: string, source: string): void {
  linePushCalls.push({ ts: Date.now(), userId, source });
  if (linePushCalls.length > MAX_HISTORY) linePushCalls.splice(0, linePushCalls.length - MAX_HISTORY);
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

export function getLinePushUsage() {
  const thisMonth = callsThisMonth(linePushCalls);
  const limit = Number(process.env.LINE_PUSH_LIMIT) || 300;
  const today = callsSince(linePushCalls, 86_400_000);

  // Per-source breakdown
  const bySource: Record<string, number> = {};
  for (const c of linePushCalls) {
    bySource[c.source] = (bySource[c.source] || 0) + 1;
  }

  // Recent (last 10)
  const recent = linePushCalls.slice(-10).reverse().map((c) => ({
    time: new Date(c.ts).toISOString(),
    userId: c.userId.substring(0, 8) + "...",
    source: c.source,
  }));

  return {
    limit,
    thisMonth,
    remaining: Math.max(0, limit - thisMonth),
    pct: Math.round((thisMonth / limit) * 100),
    today,
    total: linePushCalls.length,
    bySource,
    recent,
  };
}
