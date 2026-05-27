import Anthropic from "@anthropic-ai/sdk";
import { getToolDefinitions, executeTool, findTool, type ToolContext } from "./tools/index.js";
import type { MediaData } from "./media.js";
import { lineClient } from "./line.js";
import { trackGemini } from "./admin/usage-tracker.js";
import {
  saveMessage,
  loadHistory,
  searchMemory,
  formatMemoryForPrompt,
  DEFAULT_MEMORY_CONFIG,
} from "./memory/index.js";
import { getActiveAgent, getAgentSkills, listSkills } from "./agents/registry.js";
import type { AgentConfig, SkillConfig } from "./agents/types.js";

// ===== Provider detection (dynamic — เปลี่ยนได้จาก admin) =====
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function getGeminiKey(): string { return process.env.GEMINI_API_KEY?.trim() || ""; }
function getGeminiModel(): string { return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"; }
function getOllamaBaseUrl(): string { return process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434"; }
function getOllamaModel(): string { return process.env.OLLAMA_MODEL?.trim() || "glm-4.7-flash"; }

// ตรวจว่า provider ไหนพร้อมใช้
export function getAvailableProviders(): Array<{ id: string; model: string; ready: boolean }> {
  return [
    { id: "gemini", model: getGeminiModel(), ready: !!getGeminiKey() },
    { id: "ollama", model: getOllamaModel(), ready: !!process.env.OLLAMA_MODEL?.trim() },
    { id: "anthropic", model: "claude-sonnet-4", ready: !!process.env.ANTHROPIC_API_KEY?.trim() },
  ];
}

// Primary provider — เปลี่ยนได้ผ่าน AI_PRIMARY_PROVIDER env/override
function getAIProvider(): string {
  const forced = process.env.AI_PRIMARY_PROVIDER?.trim();
  if (forced) {
    const avail = getAvailableProviders().find((p) => p.id === forced && p.ready);
    if (avail) return forced;
  }
  // Auto-detect ตามลำดับ: gemini → ollama → anthropic → none
  if (getGeminiKey()) return "gemini";
  if (process.env.OLLAMA_MODEL?.trim()) return "ollama";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  return "none";
}

// Fallback provider (ตัวถัดไปที่พร้อมใช้)
export function getFallbackProvider(): string | null {
  const primary = getAIProvider();
  const avail = getAvailableProviders().filter((p) => p.ready && p.id !== primary);
  return avail.length > 0 ? avail[0].id : null;
}

export function getProviderInfo() {
  const primary = getAIProvider();
  const fallback = getFallbackProvider();
  const all = getAvailableProviders();
  const primaryModel = all.find((p) => p.id === primary)?.model || "none";
  const fallbackModel = all.find((p) => p.id === fallback)?.model || null;
  return { primary, primaryModel, fallback, fallbackModel, available: all.filter((p) => p.ready) };
}

let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropicClient) _anthropicClient = new Anthropic();
  return _anthropicClient;
}

function getProviderLabel(provider: string): string {
  const labels: Record<string, () => string> = {
    gemini: () => `gemini (${getGeminiModel()})`,
    ollama: () => `ollama (${getOllamaModel()})`,
    anthropic: () => "anthropic (claude-sonnet-4)",
    none: () => "none",
  };
  return (labels[provider] || labels.none)();
}
console.log(`[AI] Provider: ${getProviderLabel(getAIProvider())}`);

function getSystemPrompt(agent?: AgentConfig, skills?: Array<SkillConfig & { priority: number }>): string {
  // ถ้า agent มี custom system prompt → ใช้เลย
  if (agent?.systemPrompt) return agent.systemPrompt;

  const now = new Date().toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  let base = `You are MyClaw, a helpful AI assistant on LINE.
Current date/time: ${now} (Asia/Bangkok)
IMPORTANT: Always reply in the SAME language the user writes in. If the user writes in Thai, reply in Thai only. Never switch to another language.
Reply concisely. You have access to tools - use them when needed.
You can receive and understand images, audio messages, videos, stickers, locations, and files that users send.
When the user refers to relative dates ("yesterday", "last night", "เมื่อคืน"), always use the current date above to determine the exact date before searching.

Key capabilities:
- When the user asks you to DO something at a scheduled time (e.g. "send me a cat picture in 5 minutes", "summarize news every morning"), use the cron tool with taskType "ai". This spawns a full AI chat at the scheduled time that can use all tools (web_search, image, message push_image, etc).
- Only use cron taskType "text" for simple text reminders/alarms.
- You can search the web (web_search), fetch web pages (web_fetch), analyze images (image), send images (message push_image), generate speech (tts), and control a browser (browser).

Searching:
Before searching, THINK about what the user actually wants. Consider: the current date/time, what specific content they want, which source they mentioned, and what context is implied. Build a precise search query — vague queries give bad results. If the user mentions a source, include it in the query. If results are wrong, try different keywords — don't just give up or use a different source without telling the user.`;

  // เพิ่ม skill context ให้ AI รู้ว่าทำอะไรได้/ไม่ได้
  if (skills && skills.length > 0) {
    const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    base += `\n\nYour assigned skills:\n${skillList}\nYou can ONLY use tools related to these skills. If the user asks for something outside your skills, politely explain which capabilities you have and suggest what you can help with instead.`;
  }
  return base;
}

const MAX_HISTORY = 20;

const memoryConfig = {
  ...DEFAULT_MEMORY_CONFIG,
  dataDir: process.env.DATA_DIR || "./data",
};

// ===== Chat result (text + optional media) =====
export interface ChatResult {
  text: string;
  audioUrl?: string;
  audioDuration?: number;
  imageUrl?: string;
}

// Audio result จาก TTS tool (set ระหว่าง agent loop, อ่านหลัง loop จบ)
type AudioResult = { url: string; duration: number };
let _lastAudioResult: AudioResult | undefined;

// Image result จาก message tool (set ระหว่าง agent loop)
let _lastImageUrl: string | undefined;

/** เช็ค tool result ว่ามี audioUrl หรือ imageUrl มั้ย (เรียกหลัง executeTool) */
function checkToolResultForMedia(result: string): void {
  try {
    const parsed = JSON.parse(result);
    if (parsed.audioUrl && parsed.success) {
      _lastAudioResult = { url: parsed.audioUrl, duration: parsed.duration || 0 };
      console.log(`[AI] Audio detected from TTS tool: ${parsed.audioUrl}`);
    }
    if (parsed.imageUrl && parsed.success) {
      _lastImageUrl = parsed.imageUrl;
      console.log(`[AI] Image detected: ${parsed.imageUrl}`);
    }
  } catch { /* not JSON, ignore */ }
}

/**
 * Core agent loop (do-until) + Memory System
 * @param options.skipHistory - true = ไม่โหลด/บันทึก history (สำหรับ background tasks เช่น cron AI)
 */
export interface ChatOptions {
  skipHistory?: boolean;
}

export async function chat(userId: string, message: string, media?: MediaData, options?: ChatOptions): Promise<ChatResult> {
  const provider = getAIProvider();
  if (provider === "none") {
    return { text: "ยังไม่ได้ตั้งค่า AI provider กรุณาใส่ getGeminiKey(), getOllamaModel() หรือ ANTHROPIC_API_KEY ใน .env" };
  }

  // Load active agent config + skills → filter tools
  let activeAgent: AgentConfig | undefined;
  let agentSkills: Array<SkillConfig & { priority: number }> = [];
  let filteredTools = getToolDefinitions(); // default: all tools
  try {
    activeAgent = getActiveAgent(memoryConfig.dataDir);
    agentSkills = getAgentSkills(memoryConfig.dataDir, activeAgent.id);

    // Filter tools ตาม assigned skills
    if (agentSkills.length > 0) {
      const allowedToolNames = new Set<string>();
      for (const skill of agentSkills) {
        for (const t of skill.tools) allowedToolNames.add(t);
      }
      filteredTools = getToolDefinitions().filter((t) => allowedToolNames.has(t.name));
    } else {
      filteredTools = []; // ไม่มี skill = ไม่มี tools
    }

    const skillNames = agentSkills.map((s) => s.name).join(", ");
    console.log(`[AI] Agent: "${activeAgent.name}" (${activeAgent.provider}/${activeAgent.model}) | Skills: ${skillNames || "none"} | Tools: ${filteredTools.length}`);
  } catch { /* agent tables not ready yet, use defaults */ }

  const skip = options?.skipHistory ?? false;

  // 1. โหลด history จาก DB (skip สำหรับ background tasks)
  const dbHistory = skip ? [] : loadHistory(userId, MAX_HISTORY, memoryConfig);

  // 2. ค้นหา memory ที่เกี่ยวข้อง (hybrid search)
  let memoryContext = "";
  try {
    const results = await searchMemory(message, userId, memoryConfig);
    memoryContext = formatMemoryForPrompt(results);
    if (memoryContext) {
      console.log(`[memory] Found ${results.length} relevant memories`);
    }
  } catch (err) {
    console.error("[memory] Search failed:", err);
  }

  // 3. ประกอบ system prompt + memory context (ใช้ agent's custom prompt + skill context)
  const basePrompt = getSystemPrompt(activeAgent, agentSkills);
  const fullSystemPrompt = memoryContext
    ? `${basePrompt}\n\nNote: The memories below are from PAST conversations and may be outdated. Do NOT confuse them with current facts.\n\n${memoryContext}`
    : basePrompt;

  // บันทึกข้อความ user ลง DB + index เข้า memory
  // ถ้ามี media → รอ AI ตอบก่อน แล้วเก็บ enriched message พร้อม description
  if (!skip && !media) {
    saveMessage(userId, "user", message, memoryConfig).catch(console.error);
  }

  let reply: string;

  // เก็บ media result จาก tools (ถ้ามี)
  _lastAudioResult = undefined;
  _lastImageUrl = undefined;

  console.log(`[AI] Using: ${getProviderLabel(provider)}`);

  if (provider === "gemini") {
    try {
      reply = await chatGemini(message, dbHistory, fullSystemPrompt, userId, media, filteredTools);
    } catch (err: any) {
      // Auto-fallback: ถ้า primary error → ลองใช้ fallback แทน
      const fb = getFallbackProvider();
      if (fb === "ollama") {
        console.log(`[AI] Gemini failed (${err?.message?.substring(0, 80)}), falling back to Ollama (${getOllamaModel()})`);
        reply = await chatOllama(message, dbHistory, fullSystemPrompt, userId, filteredTools);
      } else if (fb === "anthropic") {
        console.log(`[AI] Gemini failed, falling back to Anthropic`);
        reply = await chatAnthropic(message, dbHistory, fullSystemPrompt, userId, media, filteredTools);
      } else {
        throw err;
      }
    }
  } else if (provider === "ollama") {
    reply = await chatOllama(message, dbHistory, fullSystemPrompt, userId, filteredTools);
  } else {
    reply = await chatAnthropic(message, dbHistory, fullSystemPrompt, userId, media, filteredTools);
  }

  // ถ้ามี media → เก็บ user message พร้อม AI description/transcript (เหมือน OpenClaw)
  if (!skip && media) {
    const isAudioVideo = media.mimeType.startsWith("audio/") || media.mimeType.startsWith("video/");
    const mediaType = media.mimeType.startsWith("image/") ? "Image"
      : media.mimeType.startsWith("video/") ? "Video"
      : media.mimeType.startsWith("audio/") ? "Audio"
      : "Media";
    // audio/video → เก็บ transcript เต็ม, image → เก็บ description สั้น
    const desc = isAudioVideo
      ? reply.replace(/\n/g, " ")
      : reply.substring(0, 200).replace(/\n/g, " ");
    saveMessage(userId, "user", `[${mediaType}: ${desc}]`, memoryConfig).catch(console.error);
  }

  // บันทึกคำตอบ AI ลง DB + index เข้า memory (skip สำหรับ background tasks)
  if (!skip) {
    saveMessage(userId, "assistant", reply, memoryConfig).catch(console.error);
  }

  const result: ChatResult = { text: reply };
  const audio = _lastAudioResult as AudioResult | undefined;
  if (audio) {
    result.audioUrl = audio.url;
    result.audioDuration = audio.duration;
  }
  if (_lastImageUrl) {
    result.imageUrl = _lastImageUrl;
  }
  return result;
}


// ===== Fallback: parse tool call from text =====
function parseToolCallFromText(
  text: string,
): { name: string; args: Record<string, unknown> } | null {
  if (!text) return null;
  try {
    const match = text.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})[\s\S]*?\}/);
    if (match) {
      const name = match[1];
      const args = JSON.parse(match[2]);
      if (findTool(name)) return { name, args };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

// ===== Google Gemini Provider =====
async function chatGemini(
  message: string,
  dbHistory: Array<{ role: string; content: string }>,
  systemPrompt: string,
  userId: string,
  media?: MediaData,
  toolDefs?: ReturnType<typeof getToolDefinitions>,
): Promise<string> {
  const toolCtx: ToolContext = { userId, lineClient };
  if (!toolDefs) toolDefs = getToolDefinitions();

  // Gemini format: role = "user" | "model"
  type GeminiPart = { text: string } | { functionCall: { name: string; args: Record<string, unknown> } } | { functionResponse: { name: string; response: { result: string } } } | { inlineData: { mimeType: string; data: string } };
  type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

  const contents: GeminiContent[] = [];

  // แปลง history เป็น Gemini format
  for (const m of dbHistory.slice(-(MAX_HISTORY - 1))) {
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  // User message + inline media (image/video/audio → Gemini multimodal)
  const userParts: GeminiPart[] = [{ text: message }];
  const GEMINI_INLINE_PREFIXES = ["image/", "video/", "audio/"];
  if (media && GEMINI_INLINE_PREFIXES.some((p) => media.mimeType.startsWith(p))) {
    userParts.push({ inlineData: { mimeType: media.mimeType, data: media.buffer.toString("base64") } });
  }
  contents.push({ role: "user", parts: userParts });

  // แปลง tools เป็น Gemini functionDeclarations
  // ปิด tools เมื่อมี media (video/audio) — Gemini ทำ multimodal + tools พร้อมกันไม่ดี
  const hasHeavyMedia = media && (media.mimeType.startsWith("video/") || media.mimeType.startsWith("audio/"));
  const geminiTools = toolDefs.length > 0 && !hasHeavyMedia
    ? [{
        functionDeclarations: toolDefs.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        })),
      }]
    : undefined;

  // do-until loop
  let lastText = "";
  let maxLoops = 10;

  while (maxLoops-- > 0) {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 8192 },
    };
    if (geminiTools) body.tools = geminiTools;

    const url = `${GEMINI_BASE_URL}/models/${getGeminiModel()}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": getGeminiKey(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), // 60s timeout ป้องกัน hang
    });

    if (!res.ok) {
      const err = await res.text();
      trackGemini({ endpoint: "chat", model: getGeminiModel(), status: res.status, error: true });
      throw new Error(`Gemini API error: ${res.status} ${err}`);
    }

    const json = (await res.json()) as {
      candidates: Array<{
        content: {
          role: string;
          parts: Array<{
            text?: string;
            functionCall?: { name: string; args: Record<string, unknown> };
          }>;
        };
        finishReason: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };

    trackGemini({
      endpoint: "chat", model: getGeminiModel(),
      promptTokens: json.usageMetadata?.promptTokenCount,
      completionTokens: json.usageMetadata?.candidatesTokenCount,
      totalTokens: json.usageMetadata?.totalTokenCount,
    });

    const candidate = json.candidates?.[0];
    if (!candidate) {
      lastText = "(no response from Gemini)";
      break;
    }

    const parts = candidate.content.parts;

    // เก็บ response ลง contents
    contents.push({ role: "model", parts: parts as GeminiPart[] });

    // เช็ค function calls
    const functionCalls = parts.filter((p) => p.functionCall);
    if (functionCalls.length > 0) {
      const responseParts: GeminiPart[] = [];
      for (const part of functionCalls) {
        const fc = part.functionCall!;
        console.log(`[tool] ${fc.name}(${JSON.stringify(fc.args)})`);
        const result = await executeTool(fc.name, fc.args, toolCtx);
        checkToolResultForMedia(result);
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: { result },
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    // ถ้าไม่มี function call = จบ
    const textParts = parts.filter((p) => p.text).map((p) => p.text!);
    lastText = textParts.join("\n");
    break;
  }

  return lastText || "(no response)";
}

// ===== Ollama Provider (OpenAI-compatible API) =====
async function chatOllama(
  message: string,
  dbHistory: Array<{ role: string; content: string }>,
  systemPrompt: string,
  userId: string,
  toolDefs?: ReturnType<typeof getToolDefinitions>,
): Promise<string> {
  const toolCtx: ToolContext = { userId, lineClient };
  const tools = toolDefs || getToolDefinitions();

  const messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of dbHistory.slice(-(MAX_HISTORY - 1))) {
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: "user", content: message });

  const ollamaTools = tools.length > 0
    ? tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }))
    : undefined;

  let lastText = "";
  let maxLoops = 10;

  while (maxLoops-- > 0) {
    const body: Record<string, unknown> = {
      model: getOllamaModel(),
      messages,
      max_tokens: 1024,
      stream: false,
    };
    if (ollamaTools) body.tools = ollamaTools;

    const res = await fetch(`${getOllamaBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 120s timeout (Ollama local อาจช้า)
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Ollama API error: ${res.status} ${err}`);
    }

    const json = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = json.choices[0];
    if (!choice) {
      console.log(`[Ollama] No choices in response:`, JSON.stringify(json).substring(0, 500));
      break;
    }
    const assistantMsg = choice.message;
    console.log(`[Ollama] Response: finish=${choice.finish_reason}, content=${(assistantMsg.content || "").substring(0, 100)}, tool_calls=${assistantMsg.tool_calls?.length || 0}`);

    messages.push(assistantMsg as any);

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        console.log(`[tool] ${tc.function.name}(${JSON.stringify(args)})`);
        const result = await executeTool(tc.function.name, args, toolCtx);
        checkToolResultForMedia(result);
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
      continue;
    }

    const textToolCall = parseToolCallFromText(assistantMsg.content || "");
    if (textToolCall) {
      console.log(`[tool/text-fallback] ${textToolCall.name}(${JSON.stringify(textToolCall.args)})`);
      const result = await executeTool(textToolCall.name, textToolCall.args, toolCtx);
      checkToolResultForMedia(result);
      messages.push({
        role: "tool",
        content: result,
        tool_call_id: `fallback-${Date.now()}`,
      });
      continue;
    }

    lastText = assistantMsg.content || "";
    break;
  }

  return lastText || "(no response)";
}

// ===== Anthropic (Claude) Provider =====
const ANTHROPIC_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function chatAnthropic(
  message: string,
  dbHistory: Array<{ role: string; content: string }>,
  systemPrompt: string,
  userId: string,
  media?: MediaData,
  toolDefs?: ReturnType<typeof getToolDefinitions>,
): Promise<string> {
  const toolCtx: ToolContext = { userId, lineClient };
  const history: Anthropic.MessageParam[] = dbHistory
    .slice(-(MAX_HISTORY - 1))
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  // User message + inline image (vision)
  if (media && ANTHROPIC_IMAGE_TYPES.has(media.mimeType)) {
    history.push({
      role: "user",
      content: [
        {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: media.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: media.buffer.toString("base64"),
          },
        },
        { type: "text" as const, text: message },
      ],
    });
  } else {
    history.push({ role: "user", content: message });
  }

  const tools = toolDefs || getToolDefinitions();

  let response: Anthropic.Message;
  do {
    response = await getAnthropicClient().messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages: history,
    });

    const assistantContent = response.content;
    history.push({ role: "assistant", content: assistantContent });

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          console.log(`[tool] ${block.name}(${JSON.stringify(block.input)})`);
          const result = await executeTool(block.name, block.input as Record<string, unknown>, toolCtx);
          checkToolResultForMedia(result);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      history.push({ role: "user", content: toolResults });
    }
  } while (response.stop_reason === "tool_use");

  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return textBlocks.map((b) => b.text).join("\n") || "(no response)";
}
