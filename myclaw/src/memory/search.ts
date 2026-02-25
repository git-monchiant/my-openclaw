/**
 * Hybrid Search — เหมือน OpenClaw
 * Vector + Keyword → merge → temporal decay → MMR reranking
 */

import { getChunksWithEmbeddings, keywordSearch } from "./store.js";
import { embedText, cosineSimilarity, isEmbeddingAvailable } from "./embeddings.js";
import { extractKeywords, buildFtsQuery } from "./query-expansion.js";
import { applyMMR } from "./mmr.js";
import { applyTemporalDecay } from "./temporal-decay.js";
import type { SearchResult, MemoryConfig } from "./types.js";
import { DEFAULT_MEMORY_CONFIG } from "./types.js";

export async function hybridSearch(
  query: string,
  config: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  userId?: string,
): Promise<SearchResult[]> {
  const { maxResults, minScore, vectorWeight, keywordWeight, dataDir } = config;

  // Map: chunkId → { vectorScore, keywordScore, text, createdAt }
  const scoreMap = new Map<
    string,
    {
      vectorScore: number;
      keywordScore: number;
      text: string;
      createdAt: number;
      chunk: SearchResult["chunk"];
    }
  >();

  // ===== Query Expansion (เหมือน OpenClaw) =====
  const keywords = extractKeywords(query);
  const ftsQuery = buildFtsQuery(keywords);

  const KB_SESSION = "__kb__";

  // ===== ทาง A: Vector Search =====
  if (isEmbeddingAvailable()) {
    try {
      const queryEmbedding = await embedText(query, dataDir);
      // Include user chunks + KB chunks (KB always included)
      const userChunks = getChunksWithEmbeddings(dataDir, userId);
      const kbChunks = userId !== KB_SESSION ? getChunksWithEmbeddings(dataDir, KB_SESSION) : [];
      const chunks = [...userChunks, ...kbChunks];

      for (const chunk of chunks) {
        const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);
        scoreMap.set(chunk.id, {
          vectorScore: similarity,
          keywordScore: 0,
          text: chunk.text,
          createdAt: chunk.createdAt,
          chunk,
        });
      }
    } catch (err) {
      console.error("[memory] Vector search failed, falling back to keyword-only:", err);
      // FTS-only fallback: ถ้า embedding ล้มเหลว ยังค้นได้ด้วย keyword
    }
  }

  // ===== ทาง B: Keyword Search (เหมือน OpenClaw: ใช้ query expansion) =====
  // ถ้าไม่มี embedding → ใช้ keyword search อย่างเดียว (FTS-only fallback)
  if (!ftsQuery && !isEmbeddingAvailable()) {
    // ถ้าไม่มี FTS query จาก expansion → ใช้ original query เป็น keyword
    const fallbackKeywords = extractKeywords(query);
    const fallbackFts = buildFtsQuery(fallbackKeywords.length > 0 ? fallbackKeywords : [query]);
    if (fallbackFts) {
      const candidateCount = Math.max(maxResults * 4, 24);
      const userKw = keywordSearch(dataDir, fallbackFts, candidateCount, userId);
      const kbKw = userId !== KB_SESSION ? keywordSearch(dataDir, fallbackFts, candidateCount, KB_SESSION) : [];
      const keywordResults = dedupeSearchResults([...userKw, ...kbKw]);
      for (const result of keywordResults) {
        scoreMap.set(result.id, {
          vectorScore: 0,
          keywordScore: result.score,
          text: result.text,
          createdAt: result.createdAt,
          chunk: {
            id: result.id,
            sessionId: userId || "",
            text: result.text,
            hash: "",
            embedding: null,
            source: "user",
            createdAt: result.createdAt,
          },
        });
      }
    }
  }

  if (ftsQuery) {
    const candidateCount = Math.max(maxResults * 4, 24);
    const userKwMain = keywordSearch(dataDir, ftsQuery, candidateCount, userId);
    const kbKwMain = userId !== KB_SESSION ? keywordSearch(dataDir, ftsQuery, candidateCount, KB_SESSION) : [];
    const keywordResults = dedupeSearchResults([...userKwMain, ...kbKwMain]);

    for (const result of keywordResults) {
      const existing = scoreMap.get(result.id);
      if (existing) {
        existing.keywordScore = result.score;
      } else {
        scoreMap.set(result.id, {
          vectorScore: 0,
          keywordScore: result.score,
          text: result.text,
          createdAt: result.createdAt,
          chunk: {
            id: result.id,
            sessionId: userId || "",
            text: result.text,
            hash: "",
            embedding: null,
            source: "user",
            createdAt: result.createdAt,
          },
        });
      }
    }
  }

  // ===== Merge scores (เหมือน OpenClaw mergeHybridResults) =====
  let merged: Array<SearchResult & { createdAt: number }> = [];

  for (const [, entry] of scoreMap) {
    const hasVector = entry.vectorScore > 0;
    const hasKeyword = entry.keywordScore > 0;

    let finalScore: number;
    let source: SearchResult["source"];

    if (hasVector && hasKeyword) {
      finalScore =
        vectorWeight * entry.vectorScore + keywordWeight * entry.keywordScore;
      source = "hybrid";
    } else if (hasVector) {
      finalScore = entry.vectorScore;
      source = "vector";
    } else {
      finalScore = entry.keywordScore;
      source = "keyword";
    }

    if (finalScore >= minScore) {
      merged.push({
        chunk: entry.chunk,
        score: finalScore,
        source,
        createdAt: entry.createdAt,
      });
    }
  }

  // ===== Temporal Decay (เหมือน OpenClaw) — skip for KB chunks =====
  if (config.temporalDecay.enabled) {
    const kbItems = merged.filter((r) => r.chunk.source === "knowledge");
    const chatItems = merged.filter((r) => r.chunk.source !== "knowledge");
    const decayed = applyTemporalDecay(chatItems, config.temporalDecay.halfLifeDays);
    merged = [...kbItems, ...decayed];
  }

  // Sort by score descending
  merged.sort((a, b) => b.score - a.score);

  // ===== MMR Reranking (เหมือน OpenClaw) =====
  if (config.mmr.enabled && merged.length > 1) {
    const mmrCandidates = merged.map((r) => ({
      id: r.chunk.id,
      score: r.score,
      text: r.chunk.text,
    }));

    const reranked = applyMMR(mmrCandidates, config.mmr.lambda, maxResults);

    // Map back to SearchResult
    const idToResult = new Map(merged.map((r) => [r.chunk.id, r]));
    const results: SearchResult[] = [];
    for (const item of reranked) {
      const original = idToResult.get(item.id);
      if (original) {
        results.push({
          chunk: original.chunk,
          score: item.score,
          source: original.source,
        });
      }
    }
    return results;
  }

  return merged.slice(0, maxResults).map(({ createdAt: _, ...r }) => r);
}

/** Deduplicate keyword results by id (keep highest score) */
function dedupeSearchResults(
  results: Array<{ id: string; text: string; score: number; createdAt: number }>,
): Array<{ id: string; text: string; score: number; createdAt: number }> {
  const map = new Map<string, { id: string; text: string; score: number; createdAt: number }>();
  for (const r of results) {
    const existing = map.get(r.id);
    if (!existing || r.score > existing.score) {
      map.set(r.id, r);
    }
  }
  return [...map.values()];
}
