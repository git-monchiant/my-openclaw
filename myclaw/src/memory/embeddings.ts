/**
 * Embedding Provider — Multi-provider (เหมือน OpenClaw)
 * ลำดับ: OLLAMA_EMBED_MODEL (ฟรี) → GEMINI_API_KEY → keyword-only
 *
 * Provider pattern: แต่ละ provider implement embedQuery + embedBatch
 */

import crypto from "node:crypto";
import { getCachedEmbedding, setCachedEmbedding, pruneEmbeddingCache } from "./store.js";
import type { EmbeddingProvider } from "./types.js";
import { trackGemini } from "../admin/usage-tracker.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL?.trim() || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY?.trim() || "";
const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ===== Provider implementations =====

function createGeminiProvider(): EmbeddingProvider {
  return {
    id: "gemini",
    model: GEMINI_EMBED_MODEL,

    async embedQuery(text: string): Promise<number[]> {
      const url = `${GEMINI_BASE_URL}/models/${GEMINI_EMBED_MODEL}:embedContent`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_QUERY",
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        trackGemini({ endpoint: "embed", model: GEMINI_EMBED_MODEL, status: res.status, error: true });
        throw new Error(`Gemini embedding error: ${res.status} ${err}`);
      }
      trackGemini({ endpoint: "embed", model: GEMINI_EMBED_MODEL });

      const json = (await res.json()) as {
        embedding: { values: number[] };
      };
      return normalizeVector(json.embedding.values);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      // Gemini batchEmbedContents
      const url = `${GEMINI_BASE_URL}/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`;
      const requests = texts.map((text) => ({
        model: `models/${GEMINI_EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }));

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify({ requests }),
      });

      if (!res.ok) {
        const err = await res.text();
        trackGemini({ endpoint: "embed-batch", model: GEMINI_EMBED_MODEL, status: res.status, error: true });
        throw new Error(`Gemini batch embedding error: ${res.status} ${err}`);
      }
      trackGemini({ endpoint: "embed-batch", model: GEMINI_EMBED_MODEL });

      const json = (await res.json()) as {
        embeddings: Array<{ values: number[] }>;
      };
      return json.embeddings.map((e) => normalizeVector(e.values));
    },
  };
}

function createOllamaProvider(): EmbeddingProvider {
  return {
    id: "ollama",
    model: OLLAMA_EMBED_MODEL,

    async embedQuery(text: string): Promise<number[]> {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Ollama embedding error: ${res.status} ${err}`);
      }

      const json = (await res.json()) as { embeddings: number[][] };
      return normalizeVector(json.embeddings[0]);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      // Ollama ไม่มี batch API → ทำทีละอัน
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await this.embedQuery(text));
      }
      return results;
    },
  };
}

// ===== Provider resolution =====

let activeProvider: EmbeddingProvider | null = null;
let resolved = false;

function resolveProvider(): EmbeddingProvider | null {
  if (resolved) return activeProvider;
  resolved = true;

  // ลำดับ: Ollama (ฟรี) → Gemini → none
  if (OLLAMA_EMBED_MODEL) {
    activeProvider = createOllamaProvider();
    console.log(`[memory] Embedding: Ollama (${OLLAMA_EMBED_MODEL})`);
  } else if (GEMINI_API_KEY) {
    activeProvider = createGeminiProvider();
    console.log(`[memory] Embedding: Gemini (${GEMINI_EMBED_MODEL})`);
  } else {
    activeProvider = null;
    console.log("[memory] No embedding provider — using keyword search only");
  }

  return activeProvider;
}

export function isEmbeddingAvailable(): boolean {
  return resolveProvider() !== null;
}

export function getEmbeddingProviderInfo(): { id: string; model: string } {
  const p = resolveProvider();
  return p ? { id: p.id, model: p.model } : { id: "none", model: "" };
}

/**
 * SHA256 hash ของ text (เหมือน OpenClaw — ใช้เป็น cache key)
 */
export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Embed texts พร้อม cache (เหมือน OpenClaw embedding pipeline)
 * 1. ตรวจ cache → ถ้ามีแล้วไม่ต้อง embed ซ้ำ
 * 2. embed ที่ยังไม่มี
 * 3. เก็บ cache
 */
export async function embedTexts(
  texts: string[],
  dataDir: string,
): Promise<number[][]> {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error("Embedding not available: no provider configured");
  }

  const results: number[][] = new Array(texts.length);
  const toEmbed: Array<{ index: number; text: string }> = [];

  // 1. ตรวจ cache ก่อน (เหมือน OpenClaw)
  for (let i = 0; i < texts.length; i++) {
    const hash = hashText(texts[i]);
    const cached = getCachedEmbedding(dataDir, hash);
    if (cached) {
      results[i] = cached;
    } else {
      toEmbed.push({ index: i, text: texts[i] });
    }
  }

  // 2. embed ที่ยังไม่มี (ใช้ batch API ของ provider)
  if (toEmbed.length > 0) {
    const newTexts = toEmbed.map((t) => t.text);
    const newEmbeddings = await provider.embedBatch(newTexts);

    for (let i = 0; i < toEmbed.length; i++) {
      const { index, text } = toEmbed[i];
      results[index] = newEmbeddings[i];

      // 3. เก็บ cache
      setCachedEmbedding(dataDir, hashText(text), newEmbeddings[i]);
    }
  }

  // Prune cache ถ้าเกิน (เหมือน OpenClaw LRU)
  pruneEmbeddingCache(dataDir);

  return results;
}

// Embed text เดียว (พร้อม cache)
export async function embedText(
  text: string,
  dataDir: string,
): Promise<number[]> {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error("Embedding not available: no provider configured");
  }

  // ตรวจ cache ก่อน
  const hash = hashText(text);
  const cached = getCachedEmbedding(dataDir, hash);
  if (cached) return cached;

  // Embed ด้วย embedQuery (ใช้ RETRIEVAL_QUERY สำหรับ Gemini)
  const embedding = await provider.embedQuery(text);
  setCachedEmbedding(dataDir, hash, embedding);
  return embedding;
}

// L2 normalization
function normalizeVector(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude < 1e-10) return vec;
  return vec.map((v) => v / magnitude);
}

// Cosine similarity ระหว่าง 2 vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom < 1e-10) return 0;
  return dot / denom;
}
