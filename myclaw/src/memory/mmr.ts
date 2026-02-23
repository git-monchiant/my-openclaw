/**
 * MMR (Maximal Marginal Relevance) — เหมือน OpenClaw
 *
 * เลือกผลลัพธ์ที่มีทั้ง relevance สูง และ ความหลากหลาย
 * ป้องกันผลลัพธ์ซ้ำๆ ที่คล้ายกัน
 *
 * MMRScore = λ * relevance - (1-λ) * max_similarity_to_selected
 */

export interface MMRCandidate {
  id: string;
  score: number;
  text: string;
}

/**
 * Jaccard token similarity (เหมือน OpenClaw)
 * เปรียบเทียบ token overlap ระหว่าง 2 texts
 */
function jaccardSimilarity(textA: string, textB: string): number {
  const tokensA = new Set(textA.toLowerCase().split(/\s+/));
  const tokensB = new Set(textB.toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Apply MMR reranking (เหมือน OpenClaw)
 *
 * @param candidates - ผลลัพธ์ที่ยังไม่ได้ rerank
 * @param lambda - balance: 0.7 = 70% relevance, 30% diversity
 * @param limit - จำนวนผลลัพธ์ที่ต้องการ
 */
export function applyMMR(
  candidates: MMRCandidate[],
  lambda: number,
  limit: number,
): MMRCandidate[] {
  if (candidates.length <= 1) return candidates;

  const selected: MMRCandidate[] = [];
  const remaining = [...candidates];

  // เลือกตัวแรก = score สูงสุด
  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift()!);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];

      // หา max similarity กับผลลัพธ์ที่เลือกแล้ว
      let maxSim = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candidate.text, sel.text);
        if (sim > maxSim) maxSim = sim;
      }

      // MMR score = λ * relevance - (1-λ) * max_similarity
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;

      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}
