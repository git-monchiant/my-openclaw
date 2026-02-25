/**
 * Admin Dashboard — Express Router
 * REST API endpoints + auth middleware สำหรับ Web Dashboard
 */

import { Router } from "express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getDb } from "../memory/store.js";
import { getMemoryStatus, indexKnowledgeDoc, deleteKnowledgeDocChunks } from "../memory/manager.js";
import { listKnowledgeDocs, getKnowledgeDoc, insertKnowledgeDoc, updateKnowledgeDoc, deleteKnowledgeDoc, countChunksBySession } from "../memory/store.js";
import { getToolDefinitions } from "../tools/index.js";
import { getRunningTasks, getTasksFromDb } from "../tools/sessions-spawn.js";
import { logBuffer, configOverrides } from "../tools/gateway.js";
import { cronTool } from "../tools/cron.js";
import { getDashboardHtml, getLoginHtml } from "./html.js";
import { getGeminiUsage, getLinePushUsage, getWebhookStats, getAgentUsage, getAllAgentsUsage, initUsageTracker, getUsageHistory } from "./usage-tracker.js";
import { sseHandler, getSSEClientCount } from "./events.js";
import { getActiveTasks, getTraces, getTrace } from "./active-tasks.js";
import { getQueueStats } from "../line.js";
import { getAllLinkedUsers } from "../google/store.js";
import { getProviderInfo } from "../ai.js";
import {
  listAgentsWithSkills, getAgent, createAgent, updateAgent, deleteAgent,
  setDefaultAgent, listSkills, assignSkill, removeSkill, getAgentLogs,
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

// ===== SSE real-time events =====
router.get("/api/events", sseHandler);

// ===== Init persistent usage tracking =====
initUsageTracker(getDataDir());

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
    sseClients: getSSEClientCount(),
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

// ===== Knowledge Base CRUD =====
router.get("/api/knowledge", (_req, res) => {
  try {
    const dataDir = getDataDir();
    const docs = listKnowledgeDocs(dataDir);
    const kbChunks = countChunksBySession(dataDir, "__kb__");
    res.json({ total: docs.length, kbChunks, docs });
  } catch (err: any) {
    res.json({ total: 0, kbChunks: 0, docs: [], error: err?.message });
  }
});

router.get("/api/knowledge/:id", (req, res) => {
  try {
    const doc = getKnowledgeDoc(getDataDir(), req.params.id);
    if (!doc) { res.status(404).json({ error: "not_found" }); return; }
    res.json(doc);
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.post("/api/knowledge", async (req, res) => {
  try {
    const { id, title, content, category } = req.body;
    if (!id || !title || !content) {
      res.status(400).json({ error: "missing_fields", message: "id, title, content are required" });
      return;
    }
    // Sanitize id
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "").substring(0, 64);
    if (!safeId) { res.status(400).json({ error: "invalid_id" }); return; }

    insertKnowledgeDoc(getDataDir(), { id: safeId, title, content, category });
    // Index into memory
    const chunkCount = await indexKnowledgeDoc(safeId, content);
    res.json({ success: true, id: safeId, chunkCount });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.put("/api/knowledge/:id", async (req, res) => {
  try {
    const dataDir = getDataDir();
    const existing = getKnowledgeDoc(dataDir, req.params.id);
    if (!existing) { res.status(404).json({ error: "not_found" }); return; }

    const { title, content, category } = req.body;
    updateKnowledgeDoc(dataDir, req.params.id, { title, content, category });

    // Re-index if content changed
    let chunkCount = existing.chunk_count;
    if (content !== undefined && content !== existing.content) {
      chunkCount = await indexKnowledgeDoc(req.params.id, content);
    }

    res.json({ success: true, id: req.params.id, chunkCount });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.delete("/api/knowledge/:id", (req, res) => {
  try {
    const dataDir = getDataDir();
    const existing = getKnowledgeDoc(dataDir, req.params.id);
    if (!existing) { res.status(404).json({ error: "not_found" }); return; }

    deleteKnowledgeDocChunks(req.params.id);
    deleteKnowledgeDoc(dataDir, req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.post("/api/knowledge/:id/reindex", async (req, res) => {
  try {
    const dataDir = getDataDir();
    const doc = getKnowledgeDoc(dataDir, req.params.id);
    if (!doc) { res.status(404).json({ error: "not_found" }); return; }

    const chunkCount = await indexKnowledgeDoc(req.params.id, doc.content);
    res.json({ success: true, id: req.params.id, chunkCount });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
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
    "GEMINI_MODEL", "OLLAMA_MODEL", "OLLAMA_BASE_URL",
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

// ===== GET /api/deps =====
function checkDep(name: string, versionFlag: string, installCmd: string) {
  try {
    const ver = execSync(`${name} ${versionFlag} 2>&1`, { timeout: 5000, stdio: "pipe" }).toString().trim().split("\n")[0];
    return { name, installed: true, version: ver, installCmd };
  } catch {
    return { name, installed: false, version: null, installCmd };
  }
}

router.get("/api/deps", (_req, res) => {
  const isMac = process.platform === "darwin";
  res.json({
    deps: [
      checkDep("ffmpeg", "-version", isMac ? "brew install ffmpeg" : "apt install -y ffmpeg"),
      checkDep("chromium", "--version", "npx playwright install chromium"),
    ],
  });
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

// ===== GET /api/usage/history =====
router.get("/api/usage/history", (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const metric = (req.query.metric as string) || "api_calls";
  res.json({ days, metric, data: getUsageHistory(days, metric) });
});

// ===== GET /api/queue =====
router.get("/api/queue", (_req, res) => {
  res.json(getQueueStats());
});

// ===== GET /api/active-tasks =====
router.get("/api/active-tasks", (_req, res) => {
  res.json(getActiveTasks());
});

// ===== Execution Traces =====
router.get("/api/traces", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(getTraces(limit));
});

router.get("/api/traces/:id", (req, res) => {
  const trace = getTrace(req.params.id);
  if (!trace) return res.status(404).json({ error: "trace not found" });
  res.json(trace);
});

// ===== GET /api/traffic =====
router.get("/api/traffic", (_req, res) => {
  res.json(getWebhookStats());
});

// ===== GET /api/google-users =====
router.get("/api/google-users", (_req, res) => {
  try {
    const users = getAllLinkedUsers(getDataDir());
    res.json({ total: users.length, users });
  } catch (err: any) {
    res.json({ total: 0, users: [], error: err?.message });
  }
});

// ===== POST /api/provider =====
router.post("/api/provider", (req, res) => {
  const { provider } = req.body || {};
  if (!provider || !["gemini", "openrouter", "ollama", "anthropic", "auto"].includes(provider)) {
    res.status(400).json({ error: "invalid_provider", message: "Provider must be: gemini, openrouter, ollama, anthropic, or auto" });
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
  const { id, name, description, provider, model, apiKey, systemPrompt } = req.body || {};
  if (!id || !name || !provider || !model) {
    res.status(400).json({ error: "missing_fields", message: "id, name, provider, model are required" });
    return;
  }
  try {
    const agent = createAgent(getDataDir(), { id, name, description, provider, model, apiKey, systemPrompt });
    res.json({ success: true, agent });
  } catch (err: any) {
    res.status(400).json({ error: err?.message });
  }
});

// ===== PUT /api/agents/:id =====
router.put("/api/agents/:id", (req, res) => {
  const { name, description, provider, model, apiKey, systemPrompt, enabled } = req.body || {};
  const result = updateAgent(getDataDir(), req.params.id, { name, description, provider, model, apiKey, systemPrompt, enabled });
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

// ===== GET /api/agents/:id/logs =====
router.get("/api/agents/:id/logs", (req, res) => {
  const agentId = req.params.id;
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  try {
    const result = getAgentLogs(getDataDir(), agentId, limit, offset);
    res.json(result);
  } catch (err: any) {
    res.json({ logs: [], total: 0, error: err?.message });
  }
});

// ===== GET /api/agents/:id/usage =====
router.get("/api/agents/:id/usage", (req, res) => {
  const agentId = req.params.id;
  try {
    res.json(getAgentUsage(agentId));
  } catch (err: any) {
    res.json({ error: err?.message });
  }
});

// ===== GET /api/agents-usage =====
router.get("/api/agents-usage", (_req, res) => {
  try {
    res.json(getAllAgentsUsage());
  } catch (err: any) {
    res.json({ error: err?.message });
  }
});

// ===== GET /api/apps =====
router.get("/api/apps", (_req, res) => {
  const dataDir = getDataDir();
  const appsDir = path.resolve(dataDir, "apps");
  try {
    ensureAppsTableSafe(dataDir);
    const db = getDb(dataDir);
    const rows = db.prepare("SELECT * FROM apps ORDER BY pinned DESC, created_at DESC").all() as Array<Record<string, any>>;

    const apps = rows.map(row => {
      const filePath = path.join(appsDir, `${row.id}.html`);
      const exists = fs.existsSync(filePath);
      let sizeHuman = formatBytes(row.size || 0);
      if (exists) {
        try { sizeHuman = formatBytes(fs.statSync(filePath).size); } catch { /* use DB size */ }
      }
      return {
        id: row.id,
        title: row.title,
        language: row.language,
        category: row.category || "other",
        size: row.size,
        sizeHuman,
        pinned: !!row.pinned,
        userId: row.user_id,
        createdAt: row.created_at,
        url: `/app/${row.id}.html`,
        fileExists: exists,
      };
    });

    res.json({ total: apps.length, apps });
  } catch (err: any) {
    res.json({ total: 0, apps: [], error: err?.message });
  }
});

// ===== POST /api/apps/:id/pin =====
router.post("/api/apps/:id/pin", (req, res) => {
  const dataDir = getDataDir();
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    ensureAppsTableSafe(dataDir);
    const db = getDb(dataDir);
    const app = db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as any;
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    const newPinned = app.pinned ? 0 : 1;
    db.prepare("UPDATE apps SET pinned = ? WHERE id = ?").run(newPinned, id);
    res.json({ success: true, id, pinned: !!newPinned });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ===== DELETE /api/apps/:id =====
router.delete("/api/apps/:id", (req, res) => {
  const dataDir = getDataDir();
  const appsDir = path.resolve(dataDir, "apps");
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const filePath = path.join(appsDir, `${id}.html`);

  try {
    // Delete file
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    // Delete from DB
    ensureAppsTableSafe(dataDir);
    getDb(dataDir).prepare("DELETE FROM apps WHERE id = ?").run(id);
    res.json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// Helper: ensure apps table without importing webapp (avoid circular)
function ensureAppsTableSafe(dataDir: string): void {
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'html',
      category TEXT NOT NULL DEFAULT 'other',
      size INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      user_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export { router as adminRouter };
