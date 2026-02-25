/**
 * expense tool — Personal expense/income log + health metrics, backed by SQLite
 * Health metrics (weight, steps, sleep, etc.) share the same table via type="health"
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

function ensureExpenseTable(dataDir: string) {
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'expense',
      amount REAL,
      category TEXT NOT NULL DEFAULT 'general',
      description TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_expense_user ON expense_log(user_id, type, date);
  `);
  return db;
}

export const expenseTool: ToolDefinition = {
  name: "expense",
  description: `Log and query personal expenses, income, and health metrics.
type field: "expense" (default) | "income" | "health"
- expense/income: amount in THB, category e.g. food, transport, shopping, bills, salary
- health: amount = metric value, category = metric name e.g. weight_kg, steps, sleep_hours, calories, water_ml

Actions:
- log: Record a new entry
- list: List recent entries (filterable by type, category, date range)
- summary: Total/count by category for a period (defaults to current month)
- delete: Remove an entry by id`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["log", "list", "summary", "delete"],
        description: "Action to perform",
      },
      type: {
        type: "string",
        enum: ["expense", "income", "health"],
        description: "Entry type (default: expense)",
      },
      amount: { type: "number", description: "Amount in THB (expense/income) or metric value (health)" },
      category: {
        type: "string",
        description: "Category: food/transport/shopping/bills/salary for money; weight_kg/steps/sleep_hours/calories for health",
      },
      description: { type: "string", description: "Brief description (required for log)" },
      date: { type: "string", description: "YYYY-MM-DD (default: today)" },
      date_from: { type: "string", description: "Start date YYYY-MM-DD for list/summary" },
      date_to: { type: "string", description: "End date YYYY-MM-DD for list/summary" },
      limit: { type: "number", description: "Max items returned for list (default 20)" },
      id: { type: "number", description: "Entry ID for delete" },
    },
    required: ["action"],
  },

  async execute(input, context?: ToolContext) {
    const userId = context?.userId;
    if (!userId) return JSON.stringify({ error: "No user context" });

    const dataDir = process.env.DATA_DIR || "./data";
    const db = ensureExpenseTable(dataDir);
    const action = input.action as string;
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" }); // YYYY-MM-DD

    if (action === "log") {
      const type = (input.type as string) || "expense";
      const amount = input.amount != null ? (input.amount as number) : null;
      const category = (input.category as string)?.trim() || "general";
      const description = (input.description as string)?.trim();
      const date = (input.date as string) || today;
      if (!description) return JSON.stringify({ error: "description required" });

      const res = db.prepare(
        "INSERT INTO expense_log (user_id, type, amount, category, description, date) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(userId, type, amount, category, description, date);
      return JSON.stringify({ success: true, id: res.lastInsertRowid, type, amount, category, description, date });
    }

    if (action === "list") {
      const type = input.type as string | undefined;
      const category = input.category as string | undefined;
      const limit = Math.min((input.limit as number) || 20, 100);
      const dateFrom = input.date_from as string | undefined;
      const dateTo = input.date_to as string | undefined;

      const conditions: string[] = ["user_id = ?"];
      const params: any[] = [userId];
      if (type) { conditions.push("type = ?"); params.push(type); }
      if (category) { conditions.push("category = ?"); params.push(category); }
      if (dateFrom) { conditions.push("date >= ?"); params.push(dateFrom); }
      if (dateTo) { conditions.push("date <= ?"); params.push(dateTo); }
      params.push(limit);

      const rows = db.prepare(
        `SELECT * FROM expense_log WHERE ${conditions.join(" AND ")} ORDER BY date DESC, id DESC LIMIT ?`,
      ).all(...params) as any[];
      return JSON.stringify({ items: rows, count: rows.length });
    }

    if (action === "summary") {
      const type = (input.type as string) || "expense";
      const monthStart = today.substring(0, 7) + "-01";
      const dateFrom = (input.date_from as string) || monthStart;
      const dateTo = (input.date_to as string) || today;

      const rows = db.prepare(`
        SELECT category, SUM(amount) as total, COUNT(*) as count
        FROM expense_log
        WHERE user_id = ? AND type = ? AND date >= ? AND date <= ?
        GROUP BY category ORDER BY total DESC
      `).all(userId, type, dateFrom, dateTo) as any[];

      const grandTotal = rows.reduce((sum, r) => sum + (r.total || 0), 0);
      return JSON.stringify({ type, date_from: dateFrom, date_to: dateTo, by_category: rows, grand_total: grandTotal });
    }

    if (action === "delete") {
      const id = input.id as number;
      if (!id) return JSON.stringify({ error: "id required" });
      db.prepare("DELETE FROM expense_log WHERE id = ? AND user_id = ?").run(id, userId);
      return JSON.stringify({ success: true });
    }

    return JSON.stringify({ error: "Unknown action" });
  },
};
