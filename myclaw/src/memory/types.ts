/**
 * Memory System Types
 * เหมือน OpenClaw memory architecture
 */

// Chunk ที่เก็บใน DB
export interface MemoryChunk {
  id: string;
  sessionId: string;
  text: string;
  embedding: number[] | null;
  hash: string; // SHA256(text) — for deduplication
  source: "user" | "assistant" | "knowledge"; // ใครพูด / knowledge = KB doc
  createdAt: number;
}

// Embedding Provider (เหมือน OpenClaw: multi-provider)
export interface EmbeddingProvider {
  id: string; // "gemini" | "ollama"
  model: string;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

// Memory Status (สำหรับ diagnostics)
export interface MemoryStatus {
  embeddingProvider: string; // "gemini" | "ollama" | "none"
  embeddingModel: string;
  searchMode: "hybrid" | "keyword-only";
  chunkCount: number;
  cacheCount: number;
}

// ผลลัพธ์จาก search
export interface SearchResult {
  chunk: MemoryChunk;
  score: number;
  source: "vector" | "keyword" | "hybrid";
}

// Config ของ memory system (เหมือน OpenClaw)
export interface MemoryConfig {
  // Chunking (เหมือน OpenClaw: 256 tokens, 32 overlap)
  chunkTokens: number;
  chunkOverlap: number;

  // Search
  maxResults: number;
  minScore: number;
  vectorWeight: number;
  keywordWeight: number;

  // MMR (Maximal Marginal Relevance) — เหมือน OpenClaw
  mmr: {
    enabled: boolean;
    lambda: number; // 0.7 = 70% relevance, 30% diversity
  };

  // Temporal Decay — เหมือน OpenClaw
  temporalDecay: {
    enabled: boolean;
    halfLifeDays: number; // 30 days = ข้อมูล 30 วัน ลด score ลงครึ่งนึง
  };

  // Paths
  dataDir: string;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  // เหมือน OpenClaw: 256 tokens, 32 overlap
  chunkTokens: 256,
  chunkOverlap: 32,

  maxResults: 6,
  minScore: 0.35,
  vectorWeight: 0.5,
  keywordWeight: 0.5,

  mmr: {
    enabled: true,
    lambda: 0.7,
  },

  temporalDecay: {
    enabled: true,
    halfLifeDays: 30,
  },

  dataDir: "./data",
};
