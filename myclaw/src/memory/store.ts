/**
 * Memory Store — SQLite storage for chunks + embeddings + cache
 * เหมือน OpenClaw: chunks + FTS5 + embedding_cache + sessions
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { MemoryChunk, MemoryStatus } from "./types.js";

let db: Database.Database | null = null;

export function getDb(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "memory.sqlite");
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  db.pragma("journal_mode = WAL");

  // ===== Schema (เหมือน OpenClaw memory-schema.ts) =====

  // Chunks table — เก็บ text + embedding + hash
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_session
      ON chunks(session_id);

    CREATE INDEX IF NOT EXISTS idx_chunks_created
      ON chunks(created_at);

    CREATE INDEX IF NOT EXISTS idx_chunks_hash
      ON chunks(hash);
  `);

  // FTS5 for keyword search (เหมือน OpenClaw)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(id, text, content=chunks, content_rowid=rowid);

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(id, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, id, text) VALUES('delete', old.id, old.text);
    END;
  `);

  // Embedding cache (เหมือน OpenClaw) — ไม่ต้อง embed ซ้ำถ้า text เดิม
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      dims INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated
      ON embedding_cache(updated_at);
  `);

  // Sessions table — เก็บ raw messages
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_session_id
      ON sessions(session_id);
  `);

  // ===== Migration: เพิ่ม source column (safe กับ DB เก่า) =====
  ensureColumn(db, "chunks", "source", "TEXT DEFAULT 'user'");

  return db;
}

// Safe migration helper — เพิ่ม column ถ้ายังไม่มี
function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!info.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[memory] Migration: added ${column} to ${table}`);
  }
}

// ===== Chunks =====

// บันทึก chunk (skip ถ้า hash ซ้ำ = text เดิม)
export function insertChunk(dataDir: string, chunk: MemoryChunk): void {
  const db = getDb(dataDir);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, session_id, text, hash, embedding, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    chunk.id,
    chunk.sessionId,
    chunk.text,
    chunk.hash,
    chunk.embedding ? JSON.stringify(chunk.embedding) : null,
    chunk.source,
    chunk.createdAt,
  );
}

// บันทึกหลาย chunks (transaction)
export function insertChunks(dataDir: string, chunks: MemoryChunk[]): void {
  const db = getDb(dataDir);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, session_id, text, hash, embedding, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((items: MemoryChunk[]) => {
    for (const chunk of items) {
      stmt.run(
        chunk.id,
        chunk.sessionId,
        chunk.text,
        chunk.hash,
        chunk.embedding ? JSON.stringify(chunk.embedding) : null,
        chunk.source,
        chunk.createdAt,
      );
    }
  });
  insertMany(chunks);
}

// ตรวจว่ามี chunk ที่ hash เดียวกันแล้วมั้ย
export function chunkExistsByHash(dataDir: string, hash: string): boolean {
  const db = getDb(dataDir);
  const row = db.prepare("SELECT 1 FROM chunks WHERE hash = ? LIMIT 1").get(hash);
  return !!row;
}

// ดึง chunks ที่มี embedding (สำหรับ vector search) — filter ตาม sessionId ถ้าระบุ
export function getChunksWithEmbeddings(
  dataDir: string,
  sessionId?: string,
): Array<MemoryChunk & { embedding: number[] }> {
  const db = getDb(dataDir);

  const query = sessionId
    ? "SELECT * FROM chunks WHERE embedding IS NOT NULL AND session_id = ?"
    : "SELECT * FROM chunks WHERE embedding IS NOT NULL";

  const rows = (sessionId
    ? db.prepare(query).all(sessionId)
    : db.prepare(query).all()) as Array<{
    id: string;
    session_id: string;
    text: string;
    hash: string;
    embedding: string;
    source: string;
    created_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    hash: row.hash,
    embedding: JSON.parse(row.embedding),
    source: (row.source || "user") as "user" | "assistant",
    createdAt: row.created_at,
  }));
}

// Keyword search ด้วย FTS5 (เหมือน OpenClaw BM25) — filter ตาม sessionId ถ้าระบุ
export function keywordSearch(
  dataDir: string,
  ftsQuery: string,
  limit: number,
  sessionId?: string,
): Array<{ id: string; text: string; score: number; createdAt: number }> {
  if (!ftsQuery) return [];

  const db = getDb(dataDir);

  try {
    const query = sessionId
      ? `SELECT c.id, c.text, c.created_at, rank
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.id
         WHERE chunks_fts MATCH ? AND c.session_id = ?
         ORDER BY rank LIMIT ?`
      : `SELECT c.id, c.text, c.created_at, rank
         FROM chunks_fts f
         JOIN chunks c ON c.id = f.id
         WHERE chunks_fts MATCH ?
         ORDER BY rank LIMIT ?`;

    const rows = (sessionId
      ? db.prepare(query).all(ftsQuery, sessionId, limit)
      : db.prepare(query).all(ftsQuery, limit)) as Array<{
      id: string;
      text: string;
      created_at: number;
      rank: number;
    }>;

    // แปลง rank เป็น score (เหมือน OpenClaw: 1/(1+rank))
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      score: 1 / (1 + Math.abs(row.rank)),
      createdAt: row.created_at,
    }));
  } catch {
    return [];
  }
}

// ===== Embedding Cache (เหมือน OpenClaw) =====

export function getCachedEmbedding(
  dataDir: string,
  hash: string,
): number[] | null {
  const db = getDb(dataDir);
  const row = db
    .prepare("SELECT embedding FROM embedding_cache WHERE hash = ?")
    .get(hash) as { embedding: string } | undefined;

  if (!row) return null;

  // Update last used time
  db.prepare("UPDATE embedding_cache SET updated_at = ? WHERE hash = ?").run(
    Date.now(),
    hash,
  );

  return JSON.parse(row.embedding);
}

export function setCachedEmbedding(
  dataDir: string,
  hash: string,
  embedding: number[],
): void {
  const db = getDb(dataDir);
  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hash, JSON.stringify(embedding), embedding.length, Date.now());
}

// Prune old cache entries (เหมือน OpenClaw LRU eviction)
export function pruneEmbeddingCache(
  dataDir: string,
  maxEntries = 10000,
): void {
  const db = getDb(dataDir);
  const count = (
    db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as {
      cnt: number;
    }
  ).cnt;

  if (count > maxEntries) {
    const toDelete = count - maxEntries;
    db.prepare(
      `DELETE FROM embedding_cache WHERE hash IN (
        SELECT hash FROM embedding_cache ORDER BY updated_at ASC LIMIT ?
      )`,
    ).run(toDelete);
  }
}

// ===== Sessions =====

export function saveSessionMessage(
  dataDir: string,
  sessionId: string,
  role: string,
  content: string,
): void {
  const db = getDb(dataDir);
  db.prepare(
    `INSERT INTO sessions (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
  ).run(sessionId, role, content, Date.now());
}

export function loadSessionMessages(
  dataDir: string,
  sessionId: string,
  limit: number,
): Array<{ role: string; content: string }> {
  const db = getDb(dataDir);
  const rows = db
    .prepare(
      `SELECT role, content FROM sessions
       WHERE session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{ role: string; content: string }>;

  return rows.reverse(); // oldest first
}

// ===== Diagnostics =====

export function getMemoryStats(dataDir: string): { chunkCount: number; cacheCount: number } {
  const db = getDb(dataDir);
  const chunks = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }).cnt;
  const cache = (db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number }).cnt;
  return { chunkCount: chunks, cacheCount: cache };
}

// Close DB
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
