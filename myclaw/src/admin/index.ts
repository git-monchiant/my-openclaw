/**
 * Admin Dashboard — Express Router
 * REST API endpoints + auth middleware สำหรับ Web Dashboard
 */

import { Router } from "express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { getDb } from "../memory/store.js";
import { getMemoryStatus } from "../memory/manager.js";
import { getToolDefinitions } from "../tools/index.js";
import { getRunningTasks, getTasksFromDb } from "../tools/sessions-spawn.js";
import { logBuffer, configOverrides } from "../tools/gateway.js";
import { cronTool } from "../tools/cron.js";
import { getDashboardHtml, getLoginHtml } from "./html.js";
import { getGeminiUsage, getLinePushUsage } from "./usage-tracker.js";
import { getProviderInfo } from "../ai.js";
import {
  listAgentsWithSkills, getAgent, createAgent, updateAgent, deleteAgent,
  setDefaultAgent, listSkills, assignSkill, removeSkill,
} from "../agents/registry.js";

const router = Router();
const startedAt = new Date().toISOString();

// ===== JSON body parser for admin routes =====
router.use(express.json());

// ===== Auth middleware =====
function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) {
    res.status(403).json({ error: "ADMIN_TOKEN not configured in .env" });
    return;
  }

  const provided =
    (req.query.token as string) ||
    req.headers.authorization?.replace("Bearer ", "");

  if (provided === token) {
    next();
    return;
  }

  // Serve login page for HTML requests — auto-fill token
  if (req.path === "/" || req.path === "") {
    res.type("html").send(getLoginHtml(token));
    return;
  }

  res.status(401).json({ error: "unauthorized" });
}

router.use(adminAuth);

// ===== Helper =====
function getDataDir(): string {
  return process.env.DATA_DIR || "./data";
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// ===== Dashboard HTML =====
router.get("/", (_req, res) => {
  res.type("html").send(getDashboardHtml());
});

// ===== GET /api/status =====
router.get("/api/status", (_req, res) => {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const dataDir = getDataDir();

  let dbStats: Record<string, number> = {};
  try {
    const db = getDb(dataDir);
    const sessions = (db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM sessions").get() as any)?.cnt || 0;
    const messages = (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as any)?.cnt || 0;
    const memories = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as any)?.cnt || 0;
    let cronJobs = 0;
    try { cronJobs = (db.prepare("SELECT COUNT(*) as cnt FROM cron_jobs").get() as any)?.cnt || 0; } catch { /* table may not exist */ }
    let bgTasks = 0;
    try { bgTasks = (db.prepare("SELECT COUNT(*) as cnt FROM background_tasks WHERE status = 'running'").get() as any)?.cnt || 0; } catch { /* table may not exist */ }
    dbStats = { sessions, messages, memories, cronJobs, backgroundTasks: bgTasks };
  } catch { /* DB not available */ }

  const providerInfo = getProviderInfo();

  res.json({
    uptime: { seconds: Math.round(uptime), human: formatUptime(uptime) },
    memory: {
      heapUsed: formatBytes(mem.heapUsed),
      heapTotal: formatBytes(mem.heapTotal),
      rss: formatBytes(mem.rss),
      heapUsedRaw: mem.heapUsed,
      rssRaw: mem.rss,
    },
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    provider: providerInfo.primary,
    model: providerInfo.primaryModel,
    fallback: providerInfo.fallback,
    fallbackModel: providerInfo.fallbackModel,
    available: providerInfo.available,
    db: dbStats,
    startedAt,
  });
});

// ===== GET /api/logs =====
router.get("/api/logs", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const level = (req.query.level as string) || "all";
  const search = (req.query.search as string) || "";

  let filtered = [...logBuffer];
  if (level !== "all") filtered = filtered.filter((l) => l.level === level);
  if (search) filtered = filtered.filter((l) => l.msg.toLowerCase().includes(search.toLowerCase()));

  res.json({
    total: logBuffer.length,
    returned: Math.min(limit, filtered.length),
    logs: filtered.slice(-limit),
  });
});

// ===== GET /api/sessions =====
router.get("/api/sessions", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const dataDir = getDataDir();

  try {
    const db = getDb(dataDir);
    const rows = db.prepare(`
      SELECT
        session_id,
        COUNT(*) as message_count,
        SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
        SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
        MAX(created_at) as last_active,
        MIN(created_at) as first_active
      FROM sessions
      GROUP BY session_id
      ORDER BY last_active DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    // Get last message preview for each session
    const sessions = rows.map((row) => {
      const lastMsg = db.prepare(
        "SELECT content FROM sessions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(row.session_id) as { content: string } | undefined;

      return {
        ...row,
        lastMessage: lastMsg?.content
          ? (lastMsg.content.length > 100 ? lastMsg.content.substring(0, 100) + "..." : lastMsg.content)
          : null,
      };
    });

    res.json({ total: sessions.length, sessions });
  } catch (err: any) {
    res.json({ total: 0, sessions: [], error: err?.message });
  }
});

// ===== GET /api/memory =====
router.get("/api/memory", (_req, res) => {
  try {
    const status = getMemoryStatus();
    const dataDir = getDataDir();
    const db = getDb(dataDir);

    const embeddedChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks WHERE embedding IS NOT NULL").get() as any)?.cnt || 0;
    const unembeddedChunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks WHERE embedding IS NULL").get() as any)?.cnt || 0;

    res.json({ ...status, embeddedChunks, unembeddedChunks });
  } catch (err: any) {
    res.json({ error: err?.message });
  }
});

// ===== GET /api/config =====
router.get("/api/config", (_req, res) => {
  const SENSITIVE = new Set([
    "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "LINE_CHANNEL_SECRET",
    "LINE_CHANNEL_ACCESS_TOKEN", "BRAVE_API_KEY", "PERPLEXITY_API_KEY",
    "XAI_API_KEY", "OPENROUTER_API_KEY", "ADMIN_TOKEN",
  ]);

  const envKeys = [
    "GEMINI_MODEL", "OLLAMA_MODEL", "OLLAMA_BASE_URL", "OLLAMA_EMBED_MODEL",
    "DATA_DIR", "PORT", "WEB_SEARCH_PROVIDER", "GEMINI_TTS_MODEL",
    "OWNER_USER_ID", "BASE_URL",
  ];

  const config: Array<{ key: string; value: string; isOverride: boolean; isSensitive: boolean }> = [];

  for (const key of envKeys) {
    const override = configOverrides.get(key);
    const env = process.env[key]?.trim();
    if (override) {
      config.push({ key, value: override, isOverride: true, isSensitive: false });
    } else if (env) {
      config.push({ key, value: env, isOverride: false, isSensitive: false });
    }
  }

  for (const key of SENSITIVE) {
    if (process.env[key]?.trim()) {
      config.push({ key, value: "***set***", isOverride: false, isSensitive: true });
    }
  }

  res.json({ config, overrideCount: configOverrides.size });
});

// ===== GET /api/tools =====
router.get("/api/tools", (_req, res) => {
  const tools = getToolDefinitions();
  res.json({ total: tools.length, tools });
});

// ===== GET /api/cron/jobs =====
router.get("/api/cron/jobs", (_req, res) => {
  const dataDir = getDataDir();
  try {
    const db = getDb(dataDir);
    // Ensure table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'").get();
    if (!tables) {
      res.json({ total: 0, jobs: [] });
      return;
    }
    const jobs = db.prepare("SELECT * FROM cron_jobs ORDER BY enabled DESC, created_at DESC").all();
    res.json({ total: jobs.length, jobs });
  } catch (err: any) {
    res.json({ total: 0, jobs: [], error: err?.message });
  }
});

// ===== GET /api/cron/runs =====
router.get("/api/cron/runs", (req, res) => {
  const jobId = (req.query.jobId as string) || "";
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const dataDir = getDataDir();

  try {
    const db = getDb(dataDir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_runs'").get();
    if (!tables) {
      res.json({ count: 0, runs: [] });
      return;
    }

    let runs;
    if (jobId) {
      runs = db.prepare("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(jobId, limit);
    } else {
      runs = db.prepare("SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?").all(limit);
    }
    res.json({ count: runs.length, runs });
  } catch (err: any) {
    res.json({ count: 0, runs: [], error: err?.message });
  }
});

// ===== POST /api/cron/jobs/:id/toggle =====
router.post("/api/cron/jobs/:id/toggle", async (req, res) => {
  const jobId = req.params.id;
  const dataDir = getDataDir();

  try {
    const db = getDb(dataDir);
    const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as any;
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.enabled) {
      // Disable — use update action
      const result = await cronTool.execute({ action: "update", jobId, enabled: false }, { userId: "admin" });
      res.json({ success: true, enabled: false, detail: JSON.parse(result) });
    } else {
      // Enable — use wake action
      const result = await cronTool.execute({ action: "wake", jobId }, { userId: "admin" });
      res.json({ success: true, enabled: true, detail: JSON.parse(result) });
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ===== DELETE /api/cron/jobs/:id =====
router.delete("/api/cron/jobs/:id", async (req, res) => {
  const jobId = req.params.id;
  try {
    const result = await cronTool.execute({ action: "remove", jobId }, { userId: "admin" });
    res.json(JSON.parse(result));
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ===== GET /api/tasks =====
router.get("/api/tasks", (_req, res) => {
  const dataDir = getDataDir();
  try {
    const running = getRunningTasks();
    const runningIds = new Set(running.keys());
    const dbTasks = getTasksFromDb(dataDir, 30);

    const tasks = dbTasks.map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      model: t.model,
      task: t.task.length > 200 ? t.task.substring(0, 200) + "..." : t.task,
      result: t.result ? (t.result.length > 300 ? t.result.substring(0, 300) + "..." : t.result) : null,
      createdAt: t.created_at,
      completedAt: t.completed_at,
      isRunning: runningIds.has(t.id),
    }));

    res.json({ total: tasks.length, activeCount: runningIds.size, tasks });
  } catch (err: any) {
    res.json({ total: 0, activeCount: 0, tasks: [], error: err?.message });
  }
});

// ===== GET /api/gemini =====
router.get("/api/gemini", (_req, res) => {
  res.json(getGeminiUsage());
});

// ===== GET /api/line-push =====
router.get("/api/line-push", (_req, res) => {
  res.json(getLinePushUsage());
});

// ===== POST /api/provider =====
router.post("/api/provider", (req, res) => {
  const { provider } = req.body || {};
  if (!provider || !["gemini", "ollama", "anthropic", "auto"].includes(provider)) {
    res.status(400).json({ error: "invalid_provider", message: "Provider must be: gemini, ollama, anthropic, or auto" });
    return;
  }

  if (provider === "auto") {
    // ลบ override → กลับไปใช้ auto-detect
    delete process.env.AI_PRIMARY_PROVIDER;
    configOverrides.delete("AI_PRIMARY_PROVIDER");
  } else {
    // ตรวจว่า provider พร้อมใช้
    const info = getProviderInfo();
    const target = info.available.find((p) => p.id === provider);
    if (!target) {
      res.status(400).json({ error: "provider_not_ready", message: `${provider} is not configured (missing API key or model)` });
      return;
    }
    process.env.AI_PRIMARY_PROVIDER = provider;
    configOverrides.set("AI_PRIMARY_PROVIDER", provider);
  }

  const updated = getProviderInfo();
  console.log(`[admin] Provider switched to: ${updated.primary} (${updated.primaryModel}), fallback: ${updated.fallback}`);
  res.json({ success: true, ...updated });
});

// ===== GET /api/agents =====
router.get("/api/agents", (_req, res) => {
  try {
    const agents = listAgentsWithSkills(getDataDir());
    res.json({ total: agents.length, agents });
  } catch (err: any) {
    res.json({ total: 0, agents: [], error: err?.message });
  }
});

// ===== POST /api/agents =====
router.post("/api/agents", (req, res) => {
  const { id, name, description, provider, model, systemPrompt } = req.body || {};
  if (!id || !name || !provider || !model) {
    res.status(400).json({ error: "missing_fields", message: "id, name, provider, model are required" });
    return;
  }
  try {
    const agent = createAgent(getDataDir(), { id, name, description, provider, model, systemPrompt });
    res.json({ success: true, agent });
  } catch (err: any) {
    res.status(400).json({ error: err?.message });
  }
});

// ===== PUT /api/agents/:id =====
router.put("/api/agents/:id", (req, res) => {
  const { name, description, provider, model, systemPrompt, enabled } = req.body || {};
  const result = updateAgent(getDataDir(), req.params.id, { name, description, provider, model, systemPrompt, enabled });
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ success: true, agent: result });
});

// ===== DELETE /api/agents/:id =====
router.delete("/api/agents/:id", (req, res) => {
  const result = deleteAgent(getDataDir(), req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ success: true });
});

// ===== POST /api/agents/:id/default =====
router.post("/api/agents/:id/default", (req, res) => {
  const result = setDefaultAgent(getDataDir(), req.params.id);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ success: true, agent: result });
});

// ===== GET /api/skills =====
router.get("/api/skills", (_req, res) => {
  try {
    const skills = listSkills(getDataDir());
    res.json({ total: skills.length, skills });
  } catch (err: any) {
    res.json({ total: 0, skills: [], error: err?.message });
  }
});

// ===== POST /api/agents/:id/skills =====
router.post("/api/agents/:id/skills", (req, res) => {
  const { skillId, priority } = req.body || {};
  if (!skillId) {
    res.status(400).json({ error: "missing_fields", message: "skillId is required" });
    return;
  }
  try {
    assignSkill(getDataDir(), req.params.id, skillId, priority || 5);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message });
  }
});

// ===== DELETE /api/agents/:id/skills/:skillId =====
router.delete("/api/agents/:id/skills/:skillId", (req, res) => {
  try {
    removeSkill(getDataDir(), req.params.id, req.params.skillId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message });
  }
});

export { router as adminRouter };
