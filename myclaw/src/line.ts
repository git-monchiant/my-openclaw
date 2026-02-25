import crypto from "crypto";
import {
  messagingApi,
  type WebhookEvent,
  type MessageEvent,
  type TextEventMessage,
  type StickerEventMessage,
  type LocationEventMessage,
  type FileEventMessage,
} from "@line/bot-sdk";
import { chat, type ChatResult } from "./ai.js";
import { downloadLineMedia, type MediaData } from "./media.js";
import { trackWebhook } from "./admin/usage-tracker.js";
import { emitDashboardEvent } from "./admin/events.js";
import { endTask } from "./admin/active-tasks.js";
import { getDb } from "./memory/store.js";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
};

/** Max file sizes for AI processing (Gemini inline base64) */
const MEDIA_LIMITS = {
  image: 10 * 1024 * 1024,   // 10MB
  audio: 10 * 1024 * 1024,   // 10MB — เกินนี้ Gemini tokens เต็ม
  video: 10 * 1024 * 1024,   // 10MB
};

export const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

// Track push messages ต่อ user เพื่อตัดสินใจว่าจะ quote reply หรือไม่
// ถ้ามี push ส่งไปหา user ระหว่างรอ AI ตอบ → ใช้ quote reply เพื่อแยกบริบท
const _pushCountByUser = new Map<string, number>();

/** เรียกทุกครั้งที่ส่ง push message ไปหา user (จาก cron, sessions_send, etc.) */
export function trackPush(userId: string): void {
  _pushCountByUser.set(userId, (_pushCountByUser.get(userId) || 0) + 1);
}

/** เช็ค + reset push count สำหรับ user */
export function consumePushCount(userId: string): number {
  const count = _pushCountByUser.get(userId) || 0;
  if (count > 0) _pushCountByUser.delete(userId);
  return count;
}

// Validate LINE signature (HMAC-SHA256) — แบบเดียวกับ OpenClaw
export function validateSignature(body: Buffer, signature: string): boolean {
  const hash = crypto
    .createHmac("SHA256", config.channelSecret)
    .update(body)
    .digest("base64");
  const hashBuffer = Buffer.from(hash);
  const signatureBuffer = Buffer.from(signature);
  if (hashBuffer.length !== signatureBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, signatureBuffer);
}

// Sticker package names (จาก OpenClaw)
const STICKER_PACKAGES: Record<string, string> = {
  "1": "Moon & James",
  "2": "Cony & Brown",
  "3": "Brown & Friends",
  "4": "Moon Special",
  "789": "LINE Characters",
  "6136": "Cony's Happy Life",
  "6325": "Brown's Life",
  "6359": "Choco",
  "6362": "Sally",
  "6370": "Edward",
  "11537": "Cony",
  "11538": "Brown",
  "11539": "Moon",
};

// ===== Strip Markdown (LINE ไม่ render markdown) =====

function stripMarkdown(text: string): string {
  return text
    // ```code block``` → เอาแค่เนื้อข้างใน
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").trim())
    // ### heading → heading (ลบ # ต้นบรรทัด)
    .replace(/^#{1,6}\s+/gm, "")
    // > blockquote → เนื้อหา
    .replace(/^>\s+/gm, "")
    // --- หรือ *** (horizontal rule) → ลบ
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // ***bold italic*** → bold italic
    .replace(/\*{3}([^*]+?)\*{3}/g, "$1")
    // **bold** → bold (รองรับข้ามบรรทัด)
    .replace(/\*{2}([\s\S]+?)\*{2}/g, "$1")
    // *italic* → italic (ไม่แตะ * bullet list ที่ขึ้นต้นบรรทัด)
    .replace(/(?<=\S)\*([^*\n]+)\*(?=\S|$)/g, "$1")
    .replace(/(?<=^|[^*])\*([^*\s][^*\n]*[^*\s])\*(?=[^*]|$)/gm, "$1")
    // [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // `inline code` → code
    .replace(/`([^`]+)`/g, "$1")
    // ลบบรรทัดว่างซ้ำ (เกิน 2 → เหลือ 2)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ===== Reply Splitter (ตัดตรงจุดที่เหมาะสม) =====

function splitReply(text: string, maxChars = 5000, maxMessages = 5): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0 && chunks.length < maxMessages) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // หาจุดตัดที่ดีที่สุดภายใน maxChars (ลำดับ: หัวข้อ → บรรทัดว่าง → ขึ้นบรรทัดใหม่)
    const window = remaining.substring(0, maxChars);
    let cutAt = -1;

    // 1. หาหัวข้อที่ขึ้นต้นด้วย ** หรือ # (markdown heading) — ตัดก่อนหัวข้อ
    const headingMatch = window.match(/\n(?=\*\*|#{1,3} )/g);
    if (headingMatch) {
      cutAt = window.lastIndexOf(headingMatch[headingMatch.length - 1]);
    }

    // 2. ถ้าไม่เจอหัวข้อ → หาบรรทัดว่าง (\n\n)
    if (cutAt < maxChars * 0.3) {
      const doubleNewline = window.lastIndexOf("\n\n");
      if (doubleNewline > maxChars * 0.3) cutAt = doubleNewline;
    }

    // 3. ถ้าไม่เจอบรรทัดว่าง → หา \n ธรรมดา
    if (cutAt < maxChars * 0.3) {
      const singleNewline = window.lastIndexOf("\n");
      if (singleNewline > maxChars * 0.3) cutAt = singleNewline;
    }

    // 4. fallback: ตัดที่ maxChars
    if (cutAt < maxChars * 0.3) cutAt = maxChars;

    chunks.push(remaining.substring(0, cutAt).trimEnd());
    remaining = remaining.substring(cutAt).trimStart();
  }

  return chunks;
}

// ===== Message Processing (เหมือน OpenClaw: รับทุกประเภท) =====

interface ProcessedMessage {
  text: string;
  media?: MediaData;
}

// ===== Message Store — เก็บ messageId → text สำหรับ quote lookup =====
// ใช้ SQLite เพื่อให้ persist ข้าม restart (in-memory cache ด้านบน สำหรับ hot path)
const _messageCache = new Map<string, string>(); // in-memory cache
const MSG_CACHE_MAX = 200;
const MSG_DB_TTL_HOURS = 24; // เก็บใน DB 24 ชม.

const DATA_DIR = process.env.DATA_DIR || "./data";

let _msgTableReady = false;
function ensureMsgTable(): void {
  if (_msgTableReady) return;
  const db = getDb(DATA_DIR);
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_messages (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  // Cleanup เก่ากว่า 24 ชม.
  db.prepare(`DELETE FROM line_messages WHERE created_at < datetime('now', '-${MSG_DB_TTL_HOURS} hours')`).run();
  _msgTableReady = true;
}

function storeMessage(messageId: string, text: string): void {
  console.log(`[msg-store] Storing: id=${messageId} text="${text.substring(0, 60)}..."`);
  // In-memory cache
  _messageCache.set(messageId, text);
  if (_messageCache.size > MSG_CACHE_MAX) {
    const first = _messageCache.keys().next().value;
    if (first) _messageCache.delete(first);
  }
  // SQLite persist
  try {
    ensureMsgTable();
    getDb(DATA_DIR).prepare(
      "INSERT OR REPLACE INTO line_messages (id, text) VALUES (?, ?)"
    ).run(messageId, text);
  } catch (err) {
    console.error(`[msg-store] DB error:`, err);
  }
}

function getStoredMessage(messageId: string): string | undefined {
  // 1. In-memory cache (fast)
  const cached = _messageCache.get(messageId);
  if (cached) {
    console.log(`[msg-store] Found in cache: id=${messageId} text="${cached.substring(0, 60)}..."`);
    return cached;
  }
  // 2. SQLite fallback (persistent across restarts)
  try {
    ensureMsgTable();
    const row = getDb(DATA_DIR).prepare(
      "SELECT text FROM line_messages WHERE id = ?"
    ).get(messageId) as { text: string } | undefined;
    if (row) {
      console.log(`[msg-store] Found in DB: id=${messageId} text="${row.text.substring(0, 60)}..."`);
      _messageCache.set(messageId, row.text); // warm cache
      return row.text;
    }
  } catch (err) {
    console.error(`[msg-store] DB lookup error:`, err);
  }
  console.log(`[msg-store] NOT FOUND: id=${messageId}`);
  return undefined;
}

async function processMessage(event: MessageEvent): Promise<ProcessedMessage | null> {
  const message = event.message;

  switch (message.type) {
    case "text": {
      const text = (message as TextEventMessage).text;

      // Store message สำหรับ quote lookup
      storeMessage(message.id, text);

      // ดึง quoted message (ถ้า user reply/quote ข้อความ)
      const quotedMessageId = (message as any).quotedMessageId as string | undefined;
      if (quotedMessageId) {
        const quotedText = getStoredMessage(quotedMessageId);
        if (quotedText) {
          console.log(`[LINE] Quote detected: "${quotedText.substring(0, 50)}..." → "${text.substring(0, 50)}"`);
          return { text: `[User is quoting/replying to this message: "${quotedText}"]\n${text}` };
        } else {
          console.log(`[LINE] Quote detected but original message not found (id: ${quotedMessageId})`);
          // Fallback: โหลด recent bot messages จาก session history เพื่อให้ AI มี context
          const userId = event.source.userId!;
          try {
            const db = getDb(DATA_DIR);
            const recentBotMsgs = db.prepare(
              `SELECT content FROM sessions WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 5`
            ).all(userId) as Array<{ content: string }>;
            if (recentBotMsgs.length > 0) {
              const msgList = recentBotMsgs.map((m, i) => `${i + 1}. "${m.content.substring(0, 150)}"`).join("\n");
              console.log(`[LINE] Quote fallback: showing ${recentBotMsgs.length} recent bot messages`);
              return { text: `[User is replying to a previous bot message (exact content unknown — quote lookup failed). Here are recent bot messages for context:\n${msgList}\nDo NOT guess which one — ask the user to clarify which message they mean, or copy-paste the text they want read aloud.]\n${text}` };
            }
          } catch { /* ignore fallback errors */ }
          return { text: `[User is replying to a previous message that is no longer cached]\n${text}` };
        }
      }

      return { text };
    }

    case "image": {
      try {
        const media = await downloadLineMedia(message.id, config.channelAccessToken);
        console.log(`[LINE] Downloaded image: ${media.mimeType} (${media.size} bytes)`);
        return { text: `[media:image mimeType=${media.mimeType} size=${Math.round(media.size/1024)}KB]`, media };
      } catch (err) {
        console.error("[LINE] Image download failed:", err);
        return { text: "[User sent an image that could not be downloaded]" };
      }
    }

    case "video": {
      try {
        const media = await downloadLineMedia(message.id, config.channelAccessToken, MEDIA_LIMITS.video, "video/mp4");
        console.log(`[LINE] Downloaded video: ${media.mimeType} (${media.size} bytes)`);
        return { text: `[media:video mimeType=${media.mimeType} size=${Math.round(media.size/1024)}KB]`, media };
      } catch (err: any) {
        console.error("[LINE] Video download failed:", err);
        const limitMB = Math.round(MEDIA_LIMITS.video / (1024 * 1024));
        if (err?.message?.includes("MB limit")) {
          return { text: `[SYSTEM: Video file too large. Inform user: max ${limitMB}MB for video files]` };
        }
        return { text: "[User sent a video that could not be downloaded]" };
      }
    }

    case "audio": {
      try {
        const media = await downloadLineMedia(message.id, config.channelAccessToken, MEDIA_LIMITS.audio, "audio/mp4");
        console.log(`[LINE] Downloaded audio: ${media.mimeType} (${media.size} bytes)`);
        return { text: `[media:audio mimeType=${media.mimeType} size=${Math.round(media.size/1024)}KB]`, media };
      } catch (err: any) {
        console.error("[LINE] Audio download failed:", err);
        const limitMB = Math.round(MEDIA_LIMITS.audio / (1024 * 1024));
        if (err?.message?.includes("MB limit")) {
          return { text: `[SYSTEM: Audio file too large. Inform user: max ${limitMB}MB for audio files]` };
        }
        return { text: "[User sent an audio message that could not be downloaded]" };
      }
    }

    case "sticker": {
      const sticker = message as StickerEventMessage;
      const packageName = STICKER_PACKAGES[sticker.packageId] ?? "sticker";
      const keywords = sticker.keywords?.slice(0, 3).join(", ") || sticker.text || "";
      return keywords
        ? { text: `[Sent a ${packageName} sticker: ${keywords}]` }
        : { text: `[Sent a ${packageName} sticker]` };
    }

    case "location": {
      const loc = message as LocationEventMessage;
      const parts = [loc.title, loc.address].filter(Boolean);
      const coords = `${loc.latitude}, ${loc.longitude}`;
      return parts.length > 0
        ? { text: `📍 ${parts.join(" — ")} (${coords})` }
        : { text: `📍 ${coords}` };
    }

    case "file": {
      const file = message as FileEventMessage;
      const fileName = file.fileName || "";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";

      // Audio files sent as file attachment → download and process like audio
      const audioExts = new Set(["m4a", "mp3", "wav", "aac", "ogg", "flac", "opus", "wma", "webm"]);
      if (audioExts.has(ext)) {
        try {
          const mimeMap: Record<string, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/opus", wma: "audio/x-ms-wma", webm: "audio/webm" };
          const media = await downloadLineMedia(message.id, config.channelAccessToken, MEDIA_LIMITS.audio, mimeMap[ext] || "audio/mp4");
          console.log(`[LINE] Downloaded audio file: ${fileName} ${media.mimeType} (${media.size} bytes)`);
          return { text: `[media:audio filename="${fileName}" mimeType=${media.mimeType} size=${Math.round(media.size/1024)}KB]`, media };
        } catch (err: any) {
          console.error(`[LINE] Audio file download failed (${fileName}):`, err);
          const limitMB = Math.round(MEDIA_LIMITS.audio / (1024 * 1024));
          if (err?.message?.includes("MB limit")) {
            return { text: `[SYSTEM: Audio file "${fileName}" too large. Inform user: max ${limitMB}MB for audio files]` };
          }
          return { text: `[User sent an audio file: ${fileName} — download failed]` };
        }
      }

      // Video files sent as file attachment → download and process like video
      const videoExts = new Set(["mp4", "mov", "avi", "mkv", "wmv"]);
      if (videoExts.has(ext)) {
        try {
          const media = await downloadLineMedia(message.id, config.channelAccessToken, MEDIA_LIMITS.video, "video/mp4");
          console.log(`[LINE] Downloaded video file: ${fileName} ${media.mimeType} (${media.size} bytes)`);
          return { text: `[media:video filename="${fileName}" mimeType=${media.mimeType} size=${Math.round(media.size/1024)}KB]`, media };
        } catch (err: any) {
          console.error(`[LINE] Video file download failed (${fileName}):`, err);
          const limitMB = Math.round(MEDIA_LIMITS.video / (1024 * 1024));
          if (err?.message?.includes("MB limit")) {
            return { text: `[SYSTEM: Video file "${fileName}" too large. Inform user: max ${limitMB}MB for video files]` };
          }
          return { text: `[User sent a video file: ${fileName} — download failed]` };
        }
      }

      return { text: `[User sent a file: ${fileName} (${file.fileSize} bytes)]` };
    }

    default:
      return null;
  }
}

// ===== Per-User Message Queue =====
// รวมข้อความที่มาติดๆ กัน (debounce 1.5s) + ถ้า AI กำลังทำงาน → เข้าคิวรอ

interface QueuedMessage {
  text: string;
  media?: MediaData;
  replyToken: string;
  quoteToken?: string;
  receivedAt: number;
}

interface UserQueue {
  processing: boolean;
  pending: QueuedMessage[];       // ข้อความที่รอ debounce
  debounceTimer?: ReturnType<typeof setTimeout>;
  mediaIncoming: number;          // จำนวน media ที่กำลัง download อยู่
  currentTask?: string;           // ข้อความที่กำลังประมวลผล (for admin)
  processingStartedAt?: number;   // เวลาเริ่มประมวลผล (for admin)
}

const _userQueues = new Map<string, UserQueue>();
const DEBOUNCE_MS = 1500; // รอ 1.5 วินาที รวมข้อความที่มาติดกัน

// เก็บ image ล่าสุดของแต่ละ user สำหรับ follow-up (เฉพาะรูปถ่าย — เอกสารถอดข้อความเก็บใน history แล้ว)
const _lastUserImage = new Map<string, { media: MediaData; at: number }>();
const IMAGE_RECALL_MS = 30 * 60 * 1000; // 30 นาที

function saveUserImage(userId: string, media: MediaData): void {
  _lastUserImage.set(userId, { media, at: Date.now() });
  console.log(`[LINE] ${userId}: saved photo for recall (${Math.round(media.size / 1024)}KB)`);
}

function getRecentImage(userId: string): MediaData | undefined {
  const saved = _lastUserImage.get(userId);
  if (saved && (Date.now() - saved.at) < IMAGE_RECALL_MS) return saved.media;
  if (saved) _lastUserImage.delete(userId);
  return undefined;
}

// Track consecutive media sends → 3rd file เป็นต้นไปทำเลยไม่ถาม
interface MediaTracker { count: number; lastAt: number; }
const _userMediaTracker = new Map<string, MediaTracker>();
const MEDIA_SESSION_MS = 10 * 60 * 1000; // 10 นาที → reset counter

function trackMediaSend(userId: string): number {
  const now = Date.now();
  const t = _userMediaTracker.get(userId);
  if (t && (now - t.lastAt) < MEDIA_SESSION_MS) {
    t.count++;
    t.lastAt = now;
    return t.count;
  }
  _userMediaTracker.set(userId, { count: 1, lastAt: now });
  return 1;
}

function getQueue(userId: string): UserQueue {
  let q = _userQueues.get(userId);
  if (!q) {
    q = { processing: false, pending: [], mediaIncoming: 0 };
    _userQueues.set(userId, q);
  }
  return q;
}

/** แยกส่วนสรุปออกจาก response ที่มีทั้ง transcript + summary */
function extractSummary(text: string): string | null {
  // หา "📋 สรุป:" หรือ "สรุป:" ที่ขึ้นต้นบรรทัด
  const match = text.match(/(?:📋\s*)?สรุป\s*[:：]\s*([\s\S]+)/i);
  if (match && match[1].trim().length > 10) {
    return "📋 สรุป:\n" + match[1].trim();
  }
  return null; // ไม่เจอส่วนสรุป → ส่งทั้งหมด
}

/** รวมข้อความ pending เป็นอันเดียว แล้วส่ง AI */
async function flushQueue(userId: string): Promise<void> {
  const q = getQueue(userId);
  if (q.pending.length === 0 || q.processing) return;

  // รวม text ทุกอัน, ใช้ media จากอันสุดท้าย, replyToken ล่าสุด
  const msgs = q.pending.splice(0);
  const combinedText = msgs.map((m) => m.text).join("\n");
  const hasMedia = msgs.some((m) => m.media);
  const lastMedia = [...msgs].reverse().find((m) => m.media)?.media;
  const latestReplyToken = msgs[msgs.length - 1].replyToken;
  const latestQuoteToken = msgs[msgs.length - 1].quoteToken;

  q.processing = true;
  q.currentTask = combinedText.substring(0, 200);
  q.processingStartedAt = Date.now();
  emitDashboardEvent("queue_change", { userId: userId.substring(0, 8), action: "start", task: q.currentTask?.substring(0, 80) });

  console.log(`[LINE] ${userId}: ${combinedText.substring(0, 100)}${msgs.length > 1 ? ` (${msgs.length} messages combined)` : ""}`);

  try {
    consumePushCount(userId);
    await lineClient.showLoadingAnimation({ chatId: userId, loadingSeconds: 60 }).catch(() => {});

    // Progress notification — ถ้า AI ทำนานเกิน 25 วินาที ส่งแจ้ง user ว่ายังทำอยู่
    let progressSent = false;
    const progressTimer = setTimeout(async () => {
      try {
        progressSent = true;
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: "text", text: "กำลังทำอยู่นะคะ รอสักครู่..." }],
        });
        trackPush(userId);
        console.log(`[LINE] ${userId}: sent progress notification (>25s)`);
      } catch { /* ignore */ }
    }, 25_000);
    // Refresh loading animation ทุก 55 วินาที ไปเรื่อยๆ จนกว่าจะเสร็จ
    const loadingRefreshInterval = setInterval(async () => {
      try {
        await lineClient.showLoadingAnimation({ chatId: userId, loadingSeconds: 60 }).catch(() => {});
        console.log(`[LINE] ${userId}: refreshed loading animation`);
      } catch { /* ignore */ }
    }, 55_000);

    // Text-only: auto-attach recent photo สำหรับ follow-up (เช่น "ยืนด้านไหน")
    const recalledImage = !hasMedia ? getRecentImage(userId) : undefined;
    if (recalledImage) console.log(`[LINE] ${userId}: auto-attaching recent photo for follow-up`);

    let result = await chat(userId, combinedText, lastMedia ?? recalledImage);
    (q as any)._lastResult = result.text; // สำหรับ trace recording
    clearTimeout(progressTimer);
    clearInterval(loadingRefreshInterval);

    // Media hold-and-wait: ถอด/วิเคราะห์เสร็จแล้ว → รอดูว่ามีคำสั่งเพิ่มมั้ย
    // full transcript อยู่ใน AI history (delegate_task result) → ถาม detail ทีหลังได้
    if (hasMedia) {
      // รูปถ่าย → เก็บ binary สำหรับ follow-up (เอกสารมี 📖 = ถอดข้อความแล้ว ไม่ต้องเก็บ)
      if (lastMedia?.mimeType.startsWith("image/") && !result.text.includes("📖")) {
        saveUserImage(userId, lastMedia);
      }
      const HOLD_MS = 2000;
      console.log(`[LINE] ${userId}: media processed, holding ${HOLD_MS}ms for follow-up...`);
      await new Promise((r) => setTimeout(r, HOLD_MS));

      if (q.pending.length > 0) {
        const followUp = q.pending.splice(0);
        const followUpText = followUp.map((m) => m.text).join("\n");
        console.log(`[LINE] ${userId}: follow-up after media: "${followUpText.substring(0, 100)}"`);

        // Follow-up ไม่แนบ media ซ้ำ — transcription/description อยู่ใน history แล้ว
        // ให้ไป orchestrator ปกติ → มี tools (TTS, delegate_task, etc.) ใช้ได้เต็มที่
        const hint = `[The user sent media earlier. Your initial analysis was: "${result.text.substring(0, 300)}"` +
          ` — The full transcription/description is in conversation history. Fulfill the follow-up using that context. You have all tools available (TTS, delegate, etc.).]\n${followUpText}`;
        result = await chat(userId, hint);
      } else {
        // ไม่มี follow-up → ส่งแค่สรุปให้ user (full transcript อยู่ใน history แล้ว)
        const summaryOnly = extractSummary(result.text);
        if (summaryOnly) {
          console.log(`[LINE] ${userId}: sending summary only (${summaryOnly.length} chars), full transcript in history (${result.text.length} chars)`);
          result = { ...result, text: summaryOnly };
        }
      }
    }

    const hadPushInterrupt = consumePushCount(userId) > 0;
    console.log(`[AI] → ${result.text.substring(0, 100)}...${hadPushInterrupt ? " (quote reply)" : ""}`);

    const messages: Array<Record<string, unknown>> = [];

    if (result.imageUrl) {
      messages.push({ type: "image", originalContentUrl: result.imageUrl, previewImageUrl: result.imageUrl });
    }
    if (result.audioUrl) {
      messages.push({ type: "audio", originalContentUrl: result.audioUrl, duration: result.audioDuration || 5000 });
    }

    // ถ้ามี audio → ส่งแค่ audio ไม่ต้องส่ง text ซ้ำ (ยกเว้นมี image ด้วย)
    if (!result.audioUrl) {
      const useQuote = hadPushInterrupt && !!latestQuoteToken;
      const chunks = splitReply(stripMarkdown(result.text));
      let firstText = true;
      for (const text of chunks) {
        const msg: Record<string, unknown> = { type: "text", text };
        if (firstText && useQuote) { msg.quoteToken = latestQuoteToken; firstText = false; }
        messages.push(msg);
      }
    }

    // replyToken หมดอายุแน่ (media processing + hold) → push เลย
    const sentMsgs = messages.slice(0, 5) as any;
    let sentResponse: any;
    if (hasMedia) {
      sentResponse = await lineClient.pushMessage({ to: userId, messages: sentMsgs });
    } else {
      try {
        sentResponse = await lineClient.replyMessage({ replyToken: latestReplyToken, messages: sentMsgs });
      } catch {
        console.log(`[LINE] replyToken expired, using push`);
        sentResponse = await lineClient.pushMessage({ to: userId, messages: sentMsgs });
      }
    }

    // Store sent messages สำหรับ quote lookup
    // Map แต่ละ sentMessage ID ตาม index ตรงกับ sentMsgs array
    try {
      const sentIds = (sentResponse as any)?.sentMessages as Array<{ id: string }> | undefined;
      console.log(`[msg-store] sentMessages from LINE: ${JSON.stringify(sentIds?.map(s => s.id))} (${sentMsgs.length} messages sent)`);
      if (sentIds) {
        for (let i = 0; i < sentIds.length && i < sentMsgs.length; i++) {
          if (sentMsgs[i].type === "text" && sentMsgs[i].text) {
            storeMessage(sentIds[i].id, sentMsgs[i].text);
          }
        }
      } else {
        console.warn(`[msg-store] No sentMessages in LINE response — quote lookup won't work for bot messages`);
      }
    } catch (err) {
      console.error(`[msg-store] Store error:`, err);
    }
  } catch (err: any) {
    console.error("[ERROR]", err);
    let errorMsg = "ขอโทษครับ เกิดข้อผิดพลาด";
    const msg = err?.message || err?.error?.error?.message || "";
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) errorMsg = "ขอโทษครับ AI quota หมด กรุณารอสักครู่";
    else if (msg.includes("rate_limit") || err?.status === 429) errorMsg = "ขอโทษครับ ส่งข้อความเร็วเกินไป กรุณารอสักครู่";
    else if (err?.status >= 500) errorMsg = "ขอโทษครับ AI server มีปัญหาชั่วคราว";

    try {
      await lineClient.pushMessage({ to: userId, messages: [{ type: "text", text: errorMsg }] });
    } catch { /* give up */ }
  } finally {
    q.processing = false;
    q.currentTask = undefined;
    q.processingStartedAt = undefined;
    endTask(userId, (q as any)._lastResult);
    emitDashboardEvent("queue_change", { userId: userId.substring(0, 8), action: "done", pending: q.pending.length });
    // ถ้ามีข้อความค้างในคิว → ประมวลผลต่อ
    if (q.pending.length > 0) {
      flushQueue(userId);
    }
  }
}

/** Queue stats สำหรับ admin dashboard */
export function getQueueStats(): Array<{
  userId: string;
  processing: boolean;
  pendingCount: number;
  oldestPendingAt: number | null;
  currentTask?: string;
  elapsedMs?: number;
}> {
  return Array.from(_userQueues.entries())
    .filter(([_, q]) => q.processing || q.pending.length > 0)
    .map(([userId, q]) => ({
      userId,
      processing: q.processing,
      pendingCount: q.pending.length,
      oldestPendingAt: q.pending[0]?.receivedAt ?? null,
      currentTask: q.currentTask,
      elapsedMs: q.processingStartedAt ? Date.now() - q.processingStartedAt : undefined,
    }));
}

/** ตรวจว่า message event นี้จะ trigger media download หรือไม่ (เรียกก่อน processMessage) */
function _isMediaMessage(event: MessageEvent): boolean {
  const t = event.message.type;
  if (t === "image" || t === "video" || t === "audio") return true;
  if (t === "file") {
    const ext = ((event.message as FileEventMessage).fileName || "").split(".").pop()?.toLowerCase() || "";
    const mediaExts = new Set(["m4a", "mp3", "wav", "aac", "ogg", "flac", "opus", "wma", "webm", "mp4", "mov", "avi", "mkv", "wmv"]);
    return mediaExts.has(ext);
  }
  return false;
}

// จัดการ webhook events จาก LINE
export async function handleWebhook(events: WebhookEvent[]): Promise<void> {
  for (const event of events) {
    if (event.type !== "message") continue;

    const userId = event.source.userId;
    const replyToken = event.replyToken;
    if (!userId || !replyToken) continue;

    trackWebhook(userId, event.message.type);

    // ตรวจว่า message นี้จะ download media → บอก queue ว่า "อย่าเพิ่ง flush — media กำลังมา"
    const q = getQueue(userId);
    const isMediaMsg = _isMediaMessage(event);
    if (isMediaMsg) q.mediaIncoming++;

    const processed = await processMessage(event);
    if (isMediaMsg) q.mediaIncoming--;
    if (!processed) continue;

    // 3rd+ consecutive media → auto-action ทำเลยไม่ถาม
    if (processed.media) {
      const mediaCount = trackMediaSend(userId);
      if (mediaCount >= 3) {
        processed.text = `[User sent media (consecutive file #${mediaCount}). Check conversation history — user has already told you what to do with previous media files. Apply the same action automatically without asking. If the pattern isn't clear, briefly describe what you perceive and ask.]`;
        console.log(`[LINE] ${userId}: auto-action mode (media #${mediaCount})`);
      }
    }

    const quoteToken = (event.message as any).quoteToken as string | undefined;

    // เพิ่มข้อความเข้าคิว
    q.pending.push({
      text: processed.text,
      media: processed.media,
      replyToken,
      quoteToken,
      receivedAt: Date.now(),
    });

    // ถ้า AI กำลังทำงาน → ข้อความจะถูกประมวลผลหลัง flush เสร็จ
    if (q.processing) {
      console.log(`[LINE] ${userId}: queued "${processed.text.substring(0, 50)}" (AI busy)`);
      continue;
    }

    // Media messages (audio/image/video) → flush ทันทีไม่ debounce
    // แยก text ที่อยู่ก่อนหน้าออก → flush แค่ media → text กลับเข้า queue เป็น follow-up
    if (processed.media) {
      if (q.debounceTimer) { clearTimeout(q.debounceTimer); q.debounceTimer = undefined; }

      // แยก: media msg อยู่ตัวสุดท้าย (เพิ่ง push) → pop ออก, เก็บ text ที่อยู่ก่อน
      const mediaMsg = q.pending.pop()!;
      const earlierText = q.pending.splice(0);
      q.pending.push(mediaMsg); // ให้ flush เห็นแค่ media

      console.log(`[LINE] ${userId}: media message — flushing immediately${earlierText.length ? ` (${earlierText.length} earlier msgs → follow-up)` : ""}`);
      flushQueue(userId); // fire-and-forget — splice pending ทันที ก่อน yield

      // คืน text กลับ queue → hold-and-wait จะเห็นเป็น follow-up
      if (earlierText.length > 0) q.pending.push(...earlierText);
      continue;
    }

    // Text-only: debounce 1.5s รวมข้อความที่มาติดกัน
    if (q.debounceTimer) clearTimeout(q.debounceTimer);
    q.debounceTimer = setTimeout(() => {
      q.debounceTimer = undefined;
      // ถ้ามี media กำลัง download อยู่ → อย่าเพิ่ง flush — media จะ flush เองเมื่อ download เสร็จ
      if (q.mediaIncoming > 0) {
        console.log(`[LINE] ${userId}: debounce fired but media downloading, skipping flush`);
        return;
      }
      flushQueue(userId);
    }, DEBOUNCE_MS);
  }
}
