/**
 * custom_api tool — Generic REST API client
 * เรียก API อะไรก็ได้ + บันทึก config ไว้ใช้ซ้ำ
 */

import type { ToolDefinition } from "./types.js";
import { isPrivateUrl } from "./web-shared.js";
import Database from "better-sqlite3";
import path from "path";
import crypto from "crypto";

// ===== DB ====
let _db: Database.Database | null = null;
function getDb(): Database.Database {
  if (_db) return _db;
  const dataDir = process.env.DATA_DIR || "./data";
  _db = new Database(path.join(dataDir, "memory.sqlite"));
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS api_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'GET',
      headers TEXT,
      auth_type TEXT DEFAULT 'none',
      auth_value TEXT,
      body_template TEXT,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return _db;
}

// ===== Constants =====
const MAX_RESPONSE_SIZE = 50_000; // 50KB text limit
const TIMEOUT_MS = 15_000;

// ===== Helpers =====
function buildHeaders(
  customHeaders?: Record<string, string>,
  authType?: string,
  authValue?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "MyClaw/1.0",
    Accept: "application/json, text/plain, */*",
  };
  if (customHeaders) Object.assign(h, customHeaders);
  if (authType === "bearer" && authValue) {
    h["Authorization"] = `Bearer ${authValue}`;
  } else if (authType === "basic" && authValue) {
    h["Authorization"] = `Basic ${Buffer.from(authValue).toString("base64")}`;
  } else if (authType === "api_key" && authValue) {
    // Default: X-API-Key header
    h["X-API-Key"] = authValue;
  }
  return h;
}

async function callApi(opts: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  authType?: string;
  authValue?: string;
}): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  // SSRF guard
  if (isPrivateUrl(opts.url)) {
    throw new Error(`Blocked: ${opts.url} is a private/internal address`);
  }

  const headers = buildHeaders(
    opts.headers,
    opts.authType,
    opts.authValue,
  );

  const fetchOpts: RequestInit = {
    method: opts.method.toUpperCase(),
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };

  if (opts.body && ["POST", "PUT", "PATCH"].includes(fetchOpts.method!)) {
    if (typeof opts.body === "string") {
      fetchOpts.body = opts.body;
    } else {
      fetchOpts.body = JSON.stringify(opts.body);
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
    }
  }

  const res = await fetch(opts.url, fetchOpts);
  const text = await res.text();
  const truncated = text.length > MAX_RESPONSE_SIZE
    ? text.substring(0, MAX_RESPONSE_SIZE) + `\n...(truncated, total ${text.length} chars)`
    : text;

  let data: unknown;
  try {
    data = JSON.parse(truncated);
  } catch {
    data = truncated;
  }

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { resHeaders[k] = v; });

  return { status: res.status, data, headers: resHeaders };
}

// ===== Tool =====
export const customApiTool: ToolDefinition = {
  name: "custom_api",
  description: `Call any REST API or manage saved API configurations.
Actions:
- "call": Make HTTP request (method, url, headers, body)
- "call_saved": Call a saved API config by name (can override body)
- "save": Save API config for reuse (name, url, method, headers, auth)
- "list": List saved API configs
- "delete": Delete saved API config by name`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["call", "call_saved", "save", "list", "delete"],
        description: "Action to perform",
      },
      // For "call"
      url: { type: "string", description: "API URL (for call action)" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method (default: GET)" },
      headers: { type: "object", description: "Custom headers as key-value pairs" },
      body: { description: "Request body (object or string)" },
      auth_type: { type: "string", enum: ["none", "bearer", "basic", "api_key"], description: "Auth type" },
      auth_value: { type: "string", description: "Auth token/key value" },
      // For "call_saved"
      name: { type: "string", description: "Saved config name (for call_saved/save/delete)" },
      override_body: { description: "Override body for call_saved" },
      // For "save"
      description: { type: "string", description: "Description of the API (for save)" },
      body_template: { description: "Default body template (for save)" },
    },
    required: ["action"],
  },

  async execute(input) {
    const action = input.action as string;

    try {
      switch (action) {
        case "call": {
          const url = input.url as string;
          if (!url) return JSON.stringify({ error: "url is required" });
          const method = (input.method as string) || "GET";
          const headers = input.headers as Record<string, string> | undefined;
          const body = input.body;
          const authType = input.auth_type as string | undefined;
          const authValue = input.auth_value as string | undefined;

          const result = await callApi({ url, method, headers, body, authType, authValue });
          return JSON.stringify({ success: true, status: result.status, data: result.data });
        }

        case "call_saved": {
          const name = input.name as string;
          if (!name) return JSON.stringify({ error: "name is required" });

          const db = getDb();
          const row = db.prepare("SELECT * FROM api_configs WHERE name = ?").get(name) as any;
          if (!row) return JSON.stringify({ error: `Config "${name}" not found` });

          let headers: Record<string, string> | undefined;
          try { headers = row.headers ? JSON.parse(row.headers) : undefined; } catch { /* ignore */ }

          let body = input.override_body;
          if (!body && row.body_template) {
            try { body = JSON.parse(row.body_template); } catch { body = row.body_template; }
          }

          const result = await callApi({
            url: row.url,
            method: row.method || "GET",
            headers,
            body,
            authType: row.auth_type,
            authValue: row.auth_value,
          });
          return JSON.stringify({ success: true, config: name, status: result.status, data: result.data });
        }

        case "save": {
          const name = input.name as string;
          const url = input.url as string;
          if (!name || !url) return JSON.stringify({ error: "name and url are required" });

          const db = getDb();
          const id = crypto.randomUUID();
          db.prepare(`
            INSERT OR REPLACE INTO api_configs (id, name, url, method, headers, auth_type, auth_value, body_template, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id, name, url,
            (input.method as string) || "GET",
            input.headers ? JSON.stringify(input.headers) : null,
            (input.auth_type as string) || "none",
            (input.auth_value as string) || null,
            input.body_template ? JSON.stringify(input.body_template) : null,
            (input.description as string) || null,
          );
          return JSON.stringify({ success: true, message: `Saved API config "${name}"` });
        }

        case "list": {
          const db = getDb();
          const rows = db.prepare("SELECT name, url, method, auth_type, description, created_at FROM api_configs ORDER BY name").all();
          return JSON.stringify({ configs: rows, total: rows.length });
        }

        case "delete": {
          const name = input.name as string;
          if (!name) return JSON.stringify({ error: "name is required" });
          const db = getDb();
          const r = db.prepare("DELETE FROM api_configs WHERE name = ?").run(name);
          return JSON.stringify({ success: true, deleted: r.changes > 0 });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    } catch (err: any) {
      return JSON.stringify({ error: err?.message || String(err) });
    }
  },
};
