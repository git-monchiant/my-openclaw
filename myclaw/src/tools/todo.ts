/**
 * todo tool — Personal to-do list backed by SQLite
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

function ensureTodoTable(dataDir: string) {
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS todo_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      due_date TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_todo_user ON todo_items(user_id, done);
  `);
  return db;
}

export const todoTool: ToolDefinition = {
  name: "todo",
  description: `Manage the user's personal to-do list.
Actions:
- add: Add a new task (text required, due_date optional YYYY-MM-DD)
- list: List tasks (filter: "pending" default | "done" | "all")
- complete: Mark a task as done (id required)
- delete: Delete a task (id required)
- clear: Remove all completed tasks`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "complete", "delete", "clear"],
        description: "Action to perform",
      },
      text: { type: "string", description: "Task text (for add)" },
      id: { type: "number", description: "Task ID (for complete/delete)" },
      filter: {
        type: "string",
        enum: ["pending", "done", "all"],
        description: "Filter for list (default: pending)",
      },
      due_date: { type: "string", description: "Optional due date YYYY-MM-DD (for add)" },
    },
    required: ["action"],
  },

  async execute(input, context?: ToolContext) {
    const userId = context?.userId;
    if (!userId) return JSON.stringify({ error: "No user context" });

    const dataDir = process.env.DATA_DIR || "./data";
    const db = ensureTodoTable(dataDir);
    const action = input.action as string;

    if (action === "add") {
      const text = (input.text as string)?.trim();
      if (!text) return JSON.stringify({ error: "text required" });
      const due = (input.due_date as string) || null;
      const res = db.prepare(
        "INSERT INTO todo_items (user_id, text, due_date) VALUES (?, ?, ?)",
      ).run(userId, text, due);
      return JSON.stringify({ success: true, id: res.lastInsertRowid, text, due_date: due });
    }

    if (action === "list") {
      const filter = (input.filter as string) || "pending";
      let rows: any[];
      if (filter === "all") {
        rows = db.prepare(
          "SELECT * FROM todo_items WHERE user_id = ? ORDER BY done ASC, id DESC LIMIT 50",
        ).all(userId) as any[];
      } else if (filter === "done") {
        rows = db.prepare(
          "SELECT * FROM todo_items WHERE user_id = ? AND done = 1 ORDER BY id DESC LIMIT 20",
        ).all(userId) as any[];
      } else {
        rows = db.prepare(
          "SELECT * FROM todo_items WHERE user_id = ? AND done = 0 ORDER BY id ASC",
        ).all(userId) as any[];
      }
      return JSON.stringify({
        items: rows.map((r) => ({
          id: r.id,
          text: r.text,
          done: !!r.done,
          due_date: r.due_date || null,
          created_at: r.created_at,
        })),
        count: rows.length,
      });
    }

    if (action === "complete") {
      const id = input.id as number;
      if (!id) return JSON.stringify({ error: "id required" });
      const res = db.prepare(
        "UPDATE todo_items SET done = 1 WHERE id = ? AND user_id = ?",
      ).run(id, userId);
      return JSON.stringify({ success: true, changed: res.changes });
    }

    if (action === "delete") {
      const id = input.id as number;
      if (!id) return JSON.stringify({ error: "id required" });
      db.prepare("DELETE FROM todo_items WHERE id = ? AND user_id = ?").run(id, userId);
      return JSON.stringify({ success: true });
    }

    if (action === "clear") {
      const res = db.prepare(
        "DELETE FROM todo_items WHERE user_id = ? AND done = 1",
      ).run(userId);
      return JSON.stringify({ success: true, deleted: res.changes });
    }

    return JSON.stringify({ error: "Unknown action" });
  },
};
