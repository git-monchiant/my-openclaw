/**
 * Query Expansion — เหมือน OpenClaw
 * แยก keywords จาก query สำหรับ FTS search
 * กรอง stopwords + รองรับ CJK (ไทย/จีน/ญี่ปุ่น)
 */

// English stopwords (เหมือน OpenClaw)
const EN_STOPWORDS = new Set([
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "it", "its", "they", "them", "their", "this", "that",
  "these", "those", "what", "which", "who", "whom", "how", "when",
  "where", "why", "am", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "having", "do", "does", "did", "doing",
  "will", "would", "shall", "should", "can", "could", "may", "might",
  "must", "a", "an", "the", "and", "but", "or", "nor", "not", "no",
  "so", "if", "then", "else", "for", "from", "to", "of", "in", "on",
  "at", "by", "with", "about", "into", "through", "during", "before",
  "after", "above", "below", "between", "out", "off", "up", "down",
  "over", "under", "again", "further", "too", "very", "just", "here",
  "there", "now", "all", "each", "every", "both", "few", "more", "most",
  "some", "any", "other", "such", "than", "also", "only", "same",
  "thing", "things", "stuff", "something", "anything", "everything",
]);

// Thai stopwords (คำเชื่อม/คำช่วย ที่ไม่มีความหมายในการค้นหา)
const TH_STOPWORDS = new Set([
  "ที่", "ของ", "ใน", "จะ", "ได้", "ให้", "เป็น", "แล้ว", "ก็", "มี",
  "อยู่", "ไม่", "กับ", "จาก", "นี้", "นั้น", "เมื่อ", "แต่", "หรือ",
  "และ", "ว่า", "คือ", "ถ้า", "มา", "ไป", "เอา", "ทำ", "อะไร",
  "ยัง", "แค่", "กัน", "ครับ", "ค่ะ", "นะ", "ดี", "ละ",
]);

// CJK character ranges (Thai + Chinese + Japanese + Korean)
const CJK_REGEX = /[\u0E00-\u0E7F\u3000-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;

/**
 * แยก keywords จาก query (เหมือน OpenClaw extractKeywords)
 */
export function extractKeywords(query: string): string[] {
  const tokens: string[] = [];

  // แยก token ด้วย whitespace + punctuation
  const words = query.split(/[\s,.:;!?()[\]{}"'`~@#$%^&*+=<>/\\|]+/);

  for (const word of words) {
    if (!word) continue;

    // ตรวจว่ามี CJK character มั้ย
    if (CJK_REGEX.test(word)) {
      // CJK: ใช้ character-level tokenization (bigrams)
      const chars = [...word].filter((c) => CJK_REGEX.test(c));
      // Unigrams
      for (const c of chars) {
        if (!TH_STOPWORDS.has(c)) {
          tokens.push(c);
        }
      }
      // Bigrams (สำหรับภาษาจีน/ญี่ปุ่น)
      for (let i = 0; i < chars.length - 1; i++) {
        const bigram = chars[i] + chars[i + 1];
        if (!TH_STOPWORDS.has(bigram)) {
          tokens.push(bigram);
        }
      }
      // ภาษาไทย: ใช้คำทั้งคำด้วย (ถ้าไม่ใช่ stopword)
      if (!TH_STOPWORDS.has(word) && word.length > 1) {
        tokens.push(word);
      }
    } else {
      // English/Latin
      const lower = word.toLowerCase();
      if (lower.length < 3) continue; // skip short words
      if (/^\d+$/.test(lower)) continue; // skip pure numbers
      if (EN_STOPWORDS.has(lower)) continue;
      tokens.push(lower);
    }
  }

  // deduplicate
  return [...new Set(tokens)];
}

/**
 * สร้าง FTS5 query จาก keywords (เหมือน OpenClaw buildFtsQuery)
 */
export function buildFtsQuery(keywords: string[]): string {
  if (keywords.length === 0) return "";
  return keywords.map((k) => `"${k.replace(/"/g, "")}"`).join(" OR ");
}
