/**
 * Memory Manager — API หลักของ memory system
 * เหมือน OpenClaw: save → chunk → hash dedup → embed (cached) → store
 */

import {
  insertChunks,
  chunkExistsByHash,
  saveSessionMessage,
  loadSessionMessages,
  getMemoryStats,
  deleteChunksByIdPrefix,
  updateKnowledgeDocChunkCount,
} from "./store.js";
import { chunkText } from "./chunker.js";
import { embedTexts, isEmbeddingAvailable, hashText, getEmbeddingProviderInfo } from "./embeddings.js";
import { hybridSearch } from "./search.js";
import type { MemoryChunk, MemoryConfig, MemoryStatus, SearchResult } from "./types.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";

// ===== Public API =====

/**
 * บันทึกข้อความลง session (persist) + index เข้า memory
 */
export async function saveMessage(
  sessionId: string,
  role: string,
  content: string,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): Promise<void> {
  // 1. บันทึก raw message ลง sessions table
  saveSessionMessage(config.dataDir, sessionId, role, content);

  // 2. Index เข้า memory (chunk → hash dedup → embed → store)
  const source: "user" | "assistant" = role === "assistant" ? "assistant" : "user";
  await indexText(sessionId, `${role}: ${content}`, source, config);
}

/**
 * โหลด session history จาก DB (persist across restart)
 */
export function loadHistory(
  sessionId: string,
  limit = 20,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): Array<{ role: string; content: string }> {
  return loadSessionMessages(config.dataDir, sessionId, limit);
}

/**
 * ค้นหาความจำที่เกี่ยวข้อง (เหมือน OpenClaw: hybrid + MMR + temporal decay)
 * แยกตาม userId — ไม่ค้นข้าม user
 */
export async function searchMemory(
  query: string,
  userId: string,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): Promise<SearchResult[]> {
  return hybridSearch(query, config, userId);
}

/**
 * แปลงผลค้นหาเป็น text สำหรับใส่ใน prompt
 * เหมือน OpenClaw: ตัด snippet ~700 chars/chunk
 */
export function formatMemoryForPrompt(
  results: SearchResult[],
  maxCharsPerChunk = 700,
): string {
  if (results.length === 0) return "";

  const snippets = results.map((r, i) => {
    const text =
      r.chunk.text.length > maxCharsPerChunk
        ? r.chunk.text.substring(0, maxCharsPerChunk) + "..."
        : r.chunk.text;
    const tag = r.chunk.source === "knowledge" ? "KB" : "Memory";
    return `[${tag} ${i + 1}] (score: ${r.score.toFixed(2)}, ${r.source})\n${text}`;
  });

  return `## Relevant memories and knowledge:\n\n${snippets.join("\n\n")}`;
}

/**
 * Memory status/diagnostics (เหมือน OpenClaw)
 */
export function getMemoryStatus(
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): MemoryStatus {
  const provider = getEmbeddingProviderInfo();
  const stats = getMemoryStats(config.dataDir);

  return {
    embeddingProvider: provider.id,
    embeddingModel: provider.model,
    searchMode: isEmbeddingAvailable() ? "hybrid" : "keyword-only",
    chunkCount: stats.chunkCount,
    cacheCount: stats.cacheCount,
  };
}

// ===== Knowledge Base =====

const KB_SESSION_ID = "__kb__";

/**
 * Index a knowledge base document into the memory system.
 * Deletes old chunks for this doc, re-chunks content, embeds, and stores.
 */
export async function indexKnowledgeDoc(
  docId: string,
  content: string,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): Promise<number> {
  // 1. Delete old chunks for this doc
  const prefix = `kb:${docId}:`;
  deleteChunksByIdPrefix(config.dataDir, prefix);

  // 2. Chunk content
  const chunks = chunkText(content, config.chunkTokens, config.chunkOverlap);
  if (chunks.length === 0) {
    updateKnowledgeDocChunkCount(config.dataDir, docId, 0);
    return 0;
  }

  const now = Date.now();
  const memoryChunks: MemoryChunk[] = chunks.map((chunk) => {
    const hash = hashText(chunk.text);
    return {
      id: `kb:${docId}:${hash.slice(0, 12)}:${now}`,
      sessionId: KB_SESSION_ID,
      text: chunk.text,
      hash,
      embedding: null,
      source: "knowledge" as const,
      createdAt: now,
    };
  });

  // 3. Embed
  if (isEmbeddingAvailable()) {
    try {
      const texts = memoryChunks.map((c) => c.text);
      const embeddings = await embedTexts(texts, config.dataDir);
      for (let i = 0; i < memoryChunks.length; i++) {
        memoryChunks[i].embedding = embeddings[i];
      }
    } catch (err) {
      console.error("[knowledge] Embedding failed, saving without vectors:", err);
    }
  }

  // 4. Store
  insertChunks(config.dataDir, memoryChunks);

  // 5. Update chunk count
  updateKnowledgeDocChunkCount(config.dataDir, docId, memoryChunks.length);

  return memoryChunks.length;
}

/**
 * Delete all chunks belonging to a knowledge base document.
 */
export function deleteKnowledgeDocChunks(
  docId: string,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
): number {
  const prefix = `kb:${docId}:`;
  return deleteChunksByIdPrefix(config.dataDir, prefix);
}

// ===== Internal =====

/**
 * Index text เข้า memory (เหมือน OpenClaw sync pipeline)
 * chunk → hash → dedup → embed (cached) → store
 */
async function indexText(
  sessionId: string,
  text: string,
  source: "user" | "assistant",
  config: MemoryConfig,
): Promise<void> {
  // 1. Chunk (เหมือน OpenClaw: 256 tokens, 32 overlap)
  const chunks = chunkText(text, config.chunkTokens, config.chunkOverlap);
  if (chunks.length === 0) return;

  const now = Date.now();
  const memoryChunks: MemoryChunk[] = [];

  for (const chunk of chunks) {
    // 2. Hash-based dedup (เหมือน OpenClaw)
    const hash = hashText(chunk.text);

    // Skip ถ้า text เดียวกันมีอยู่แล้ว
    if (chunkExistsByHash(config.dataDir, hash)) {
      continue;
    }

    memoryChunks.push({
      id: `${sessionId}:${hash.slice(0, 12)}:${now}`,
      sessionId,
      text: chunk.text,
      hash,
      embedding: null, // embed ทีหลัง
      source,
      createdAt: now,
    });
  }

  if (memoryChunks.length === 0) return;

  // 3. Embed พร้อม cache (เหมือน OpenClaw embedding pipeline)
  if (isEmbeddingAvailable()) {
    try {
      const texts = memoryChunks.map((c) => c.text);
      const embeddings = await embedTexts(texts, config.dataDir);

      for (let i = 0; i < memoryChunks.length; i++) {
        memoryChunks[i].embedding = embeddings[i];
      }
    } catch (err) {
      console.error("[memory] Embedding failed, saving without vectors:", err);
    }
  }

  // 4. Store
  insertChunks(config.dataDir, memoryChunks);
}
