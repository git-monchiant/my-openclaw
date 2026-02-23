/**
 * Text Chunker — ตัดข้อความเป็น chunks
 * เหมือน OpenClaw: ~256 tokens/chunk, 32 tokens overlap
 * Heuristic: 1 token ≈ 4 characters (conservative UTF-8 estimate)
 */

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * chunkMarkdown — เหมือน OpenClaw internal.ts chunkMarkdown()
 * ตัดตาม line boundaries, รักษา overlap ท้าย chunk เก่า
 */
export function chunkText(
  content: string,
  tokensPerChunk = 256,
  overlapTokens = 32,
): Chunk[] {
  const maxChars = Math.max(32, tokensPerChunk * 4);
  const overlapChars = Math.max(0, overlapTokens * 4);

  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let currentChunk = "";
  let startLine = 0;
  let lineIndex = 0;

  for (const line of lines) {
    const wouldBe = currentChunk + (currentChunk ? "\n" : "") + line;

    if (wouldBe.length > maxChars && currentChunk.length > 0) {
      // Flush current chunk
      chunks.push({
        text: currentChunk.trim(),
        startLine,
        endLine: lineIndex - 1,
      });

      // Keep overlap: เอาท้ายของ chunk เก่ามาต่อ (เหมือน OpenClaw)
      const overlapText = currentChunk.slice(-overlapChars);
      currentChunk = overlapText + "\n" + line;
      startLine = Math.max(0, lineIndex - countLines(overlapText));
    } else {
      currentChunk = wouldBe;
    }

    lineIndex++;
  }

  // Flush last chunk
  if (currentChunk.trim()) {
    chunks.push({
      text: currentChunk.trim(),
      startLine,
      endLine: lineIndex - 1,
    });
  }

  return chunks;
}

function countLines(text: string): number {
  return (text.match(/\n/g) || []).length;
}

// แปลง conversation messages เป็น text สำหรับ chunking
export function messagesToText(
  messages: Array<{ role: string; content: string }>,
): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");
}
