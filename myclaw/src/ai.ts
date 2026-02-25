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
import { getActiveAgent, getAgent, getOrchestratorAgent, getAgentSkills, listAgentsWithSkills, logAgentActivity } from "./agents/registry.js";
import type { AgentConfig, SkillConfig } from "./agents/types.js";
import { startTask, updateTask } from "./admin/active-tasks.js";

// Orchestrator-only synthetic tool — NOT in global registry
// Gemini ต้อง call respond_directly หรือ tool อื่นเสมอ (tool_config.mode=ANY) — ตอบ text-only ไม่ได้
const RESPOND_DIRECTLY_TOOL = {
  name: "respond_directly",
  description:
    "Use this to send a direct text reply to the user. " +
    "Call this for: greetings, simple conversation, math calculations, " +
    "follow-up questions whose answers are already in the conversation, " +
    "and after receiving a delegate_task result to relay the answer. " +
    "Do NOT call this if the user's request requires action (search, create, schedule, etc.) — " +
    "call the appropriate tool instead.",
  input_schema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The exact reply text to send to the user." },
    },
    required: ["text"],
  },
};

/** ตรวจ media ที่ต้องจัดการพิเศษ (video/audio — เฉพาะ Gemini process inline ได้, tools ต้องปิด) */
function isHeavyMedia(media?: MediaData): boolean {
  return !!(media && (media.mimeType.startsWith("video/") || media.mimeType.startsWith("audio/")));
}

/** Per-request state — local ไม่ share ระหว่าง users (แก้ race condition จาก global vars) */
interface ChatState {
  toolCallCount: number;
  lastAudioResult?: AudioResult;
  lastImageUrl?: string;
  lastVideoUrl?: string;
}

// ===== Provider detection (dynamic — เปลี่ยนได้จาก admin) =====
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function getGeminiKey(): string { return process.env.GEMINI_API_KEY?.trim() || ""; }
function getGeminiModel(): string { return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash"; }
function getOllamaBaseUrl(): string { return process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434"; }
function getOllamaModel(): string { return process.env.OLLAMA_MODEL?.trim() || "glm-4.7-flash"; }
function getOpenRouterKey(): string { return process.env.OPENROUTER_API_KEY?.trim() || ""; }
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// ตรวจว่า provider ไหนพร้อมใช้
export function getAvailableProviders(): Array<{ id: string; model: string; ready: boolean }> {
  return [
    { id: "gemini", model: getGeminiModel(), ready: !!getGeminiKey() },
    { id: "ollama", model: getOllamaModel(), ready: !!process.env.OLLAMA_MODEL?.trim() },
    { id: "anthropic", model: "claude-sonnet-4", ready: !!process.env.ANTHROPIC_API_KEY?.trim() },
    { id: "openrouter", model: "openrouter (multi-model)", ready: !!getOpenRouterKey() },
  ];
}

// Primary provider — เปลี่ยนได้ผ่าน AI_PRIMARY_PROVIDER env/override
function getAIProvider(): string {
  const forced = process.env.AI_PRIMARY_PROVIDER?.trim();
  if (forced) {
    const avail = getAvailableProviders().find((p) => p.id === forced && p.ready);
    if (avail) return forced;
  }
  // Auto-detect ตามลำดับ: gemini → openrouter → ollama → anthropic → none
  if (getGeminiKey()) return "gemini";
  if (getOpenRouterKey()) return "openrouter";
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

function getProviderLabel(provider: string, model?: string): string {
  const labels: Record<string, () => string> = {
    gemini: () => `gemini (${getGeminiModel()})`,
    ollama: () => `ollama (${getOllamaModel()})`,
    anthropic: () => "anthropic (claude-sonnet-4)",
    openrouter: () => `openrouter (${model || "multi-model"})`,
    none: () => "none",
  };
  return (labels[provider] || labels.none)();
}
console.log(`[AI] Provider: ${getProviderLabel(getAIProvider())}`);

function getSystemPrompt(agent?: AgentConfig, skills?: Array<SkillConfig & { priority: number }>): string {
  // ถ้า agent มี custom system prompt → ใช้เลย
  if (agent?.systemPrompt) return agent.systemPrompt;

  const dateObj = new Date();
  const now = dateObj.toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const nowThai = dateObj.toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const ceYear = dateObj.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", year: "numeric" });
  const beYear = parseInt(ceYear) + 543;
  let base = `You are MyClaw, a helpful AI assistant on LINE.
Current date/time: ${now} (Asia/Bangkok)
Thai date/time: ${nowThai}
Year: ${ceYear} CE = พ.ศ. ${beYear}
IMPORTANT: Always reply in the SAME language the user writes in. If the user writes in Thai, reply in Thai only. Never switch to another language.
IMPORTANT: The current year is ${ceYear} (พ.ศ. ${beYear}). When mentioning years in Thai, use พ.ศ. ${beYear} — NOT 2566 or any other year. When searching the web, always use the CE year ${ceYear}.
Reply concisely and naturally — like a helpful friend, not a robot. Never dump raw data (JSON, IDs, timestamps). Always summarize and present information in a human-readable way. You have access to tools - use them when needed.
FORMATTING: You are on LINE chat — it does NOT support markdown. NEVER use markdown tables (|---|), bold (**), headers (#), or code blocks. For tabular data (standings, rankings, scores), use plain text with emoji and line breaks like:
1. 🏆 Arsenal — 61 แต้ม (18ชนะ 7เสมอ 3แพ้)
2. Man City — 56 แต้ม (17ชนะ 5เสมอ 5แพ้)
Keep it clean and easy to read on a phone screen.
You can receive and understand images, audio messages, videos, stickers, locations, and files that users send.
You have built-in multimodal capabilities: you can SEE images/videos and HEAR audio directly — this does NOT require any tools. When you receive media inline, analyze it immediately.
When analyzing audio: transcribe what you hear. When analyzing video: visually describe what you see (scenes, people, actions, objects, any text on screen). Do NOT fabricate content — only describe what is actually there.
When the user refers to relative dates ("yesterday", "last night", "เมื่อคืน"), always use the current date above to determine the exact date before searching.

Key capabilities:
- When the user asks you to DO something at a scheduled time (e.g. "send me a cat picture in 5 minutes", "summarize news every morning"), use the cron tool with taskType "ai". This spawns a full AI chat at the scheduled time that can use all tools (web_search, image, message push_image, etc).
- Only use cron taskType "text" for simple text reminders/alarms.
- You can search the web (web_search), fetch web pages (web_fetch), analyze images (image), send images (message push_image), generate speech (tts), and control a browser (browser).

Follow-up about previous media:
When the user refers to media from a PREVIOUS message (e.g. "read it again", "นกสีอะไร", "ไปอ่านใหม่"):
- If you receive a re-analysis task WITH media attached (re-fetched inline) → analyze it fresh and answer the specific question directly. Ignore the previous analysis — do a full fresh analysis focused on what was asked.
- If you only have conversation history (no inline media) → use the previous analysis/transcript from history to answer. If the answer isn't there, say so honestly.

Searching:
Before searching, THINK about what the user actually wants. Build a precise search query — vague queries give bad results.
IMPORTANT: Search ONCE with a good query. If the first result answers the question, use it immediately — do NOT search again.
Only retry with a different query if the first search returned NO useful results or an error.
For international topics (Premier League, Serie A, world news, tech, etc.), ALWAYS search in ENGLISH (e.g. "Serie A standings February 2026").
If web_search fails, try web_fetch from: https://www.google.com/search?q=... or https://www.espn.com/soccer/scores
Then translate the answer back to the user's language.

Google Account Linking:
When a Google tool (gmail, calendar, drive, sheets) returns error "google_not_linked", you MUST:
1. Tell the user they need to connect their Google account first
2. Use the google_link tool to generate a linking URL
3. Send the URL to the user with a clear explanation
Do NOT tell the user to configure environment variables — instead, always provide the linking URL.

Calendar Issues:
When the user says their calendar is wrong, shows wrong events, connects to wrong calendar, or wants to change their default calendar:
1. Use google_link with action "reconfigure" to generate a calendar picker URL
2. Send the URL to the user — they can pick the correct calendar themselves
Do NOT ask the user for technical details — just send the reconfigure link.`;

  // เพิ่ม skill context ให้ AI รู้ว่าทำอะไรได้/ไม่ได้
  if (skills && skills.length > 0) {
    const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    base += `\n\nYour assigned skills:\n${skillList}\nYou can ONLY use tools related to these skills. However, your built-in multimodal capabilities (seeing images, hearing audio, watching video) are ALWAYS available regardless of tools. If the user asks for something outside your skills and multimodal capabilities, politely explain what you can help with.`;
  }
  return base;
}

/** สร้าง system prompt สำหรับ orchestrator — มีรายชื่อ agents + skills ทั้งหมด */
function getOrchestratorPrompt(allAgents: AgentConfig[], orchestratorName = "MyClaw"): string {
  const dateObj = new Date();
  const now = dateObj.toLocaleString("en-GB", {
    timeZone: "Asia/Bangkok",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const ceYear = dateObj.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", year: "numeric" });
  const beYear = parseInt(ceYear) + 543;

  const enabledAgents = allAgents.filter((a) => a.enabled);

  // Build skill → agents map (skill-first view for orchestrator decision making)
  type SkillEntry = { name: string; description: string; agents: Array<{ name: string; id: string }> };
  const skillMap = new Map<string, SkillEntry>();
  for (const agent of enabledAgents) {
    for (const skill of (agent.skills || [])) {
      if (!skillMap.has(skill.id)) {
        skillMap.set(skill.id, { name: skill.name, description: skill.description, agents: [] });
      }
      skillMap.get(skill.id)!.agents.push({ name: agent.name, id: agent.id });
    }
  }

  const agentCatalog = [...skillMap.values()]
    .map(({ name, description, agents }) => {
      const agentList = agents.map((a) => `"${a.name}" (agentId: "${a.id}")`).join(", ");
      return `SKILL: ${name}\n  WHAT: ${description}\n  DELEGATE TO: ${agentList}`;
    })
    .join("\n\n");

  return `You are ${orchestratorName}, a helpful AI assistant orchestrator on LINE.
Current date/time: ${now} (Asia/Bangkok)
Year: ${ceYear} CE = พ.ศ. ${beYear}
IMPORTANT: Always reply in the SAME language the user writes in. If the user writes in Thai, reply in Thai only.
IMPORTANT: The current year is ${ceYear} (พ.ศ. ${beYear}). When mentioning years in Thai, use พ.ศ. ${beYear}. When searching the web, use CE year ${ceYear}.
IMPORTANT: Always communicate naturally — like a helpful friend, not a robot. When relaying results from agents, summarize in plain language. Never show raw JSON, IDs, or technical details unless the user specifically asks for them.
FORMATTING: You are on LINE chat — it does NOT support markdown. NEVER use markdown tables (|---|), bold (**), headers (#), or code blocks. For tabular data (standings, rankings, scores), use plain text with emoji and line breaks like:
1. 🏆 Arsenal — 61 แต้ม (18ชนะ 7เสมอ 3แพ้)
2. Man City — 56 แต้ม
Keep it clean and easy to read on a phone screen.

You are the ORCHESTRATOR. You read, understand, plan, and coordinate specialist agents.

=== MANDATORY TOOL RULE ===
You MUST always call a tool. NEVER output raw text. Every response must be one of:
  - respond_directly(text="...") — for direct replies (greetings, calculations, relaying results, errors)
  - delegate_task(agentId="...", task="...") — when the request needs a specialist agent
  - cron / memory_search / user_profile / etc. — for their specific purposes

=== YOUR RESPONSIBILITIES ===
1. READ & UNDERSTAND: Analyze what the user wants — simple chat? a task? multi-step work?
2. RESPOND DIRECTLY (call respond_directly) for:
   - Greetings, simple conversation, math calculations
   - Follow-up questions whose answers are already in the conversation history
   - Relaying a result from a completed delegate_task back to the user
   - ALWAYS check memory context below first for personal info (name, preferences, past topics).
3. DELEGATE (call delegate_task) for tasks that need specialist tools:
   - SIMPLE task (search, weather, news, one action) → delegate ONCE → got result → respond_directly IMMEDIATELY.
   - MULTI-STEP task (fetch then create, search then TTS, etc.) → delegate step by step, read each result.
4. If NO agent has the required capability: respond_directly with an honest explanation.

=== MOST IMPORTANT RULE ===
When delegate_task returns a result that answers the user's question — call respond_directly IMMEDIATELY.
Do NOT delegate again for the same thing. Do NOT try to "get more details" or "verify" or "search again".
The first successful result is the answer. Summarize it and call respond_directly. DONE.
EXCEPTION: If the result is an error or empty/useless — you MAY retry once with a different query or different agent, then respond_directly.

=== SIMPLE vs MULTI-STEP ===
SIMPLE (1 delegation): weather, news, search, scores, prices, single creation, single lookup
→ delegate ONCE → read result → respond to user. FINISHED.

MULTI-STEP (2+ delegations): only when the user's request CLEARLY needs DIFFERENT capabilities in sequence:
  "อ่าน mail ให้ฟัง" → email skill + TTS skill (2 different skills)
  "หาข่าวแล้วสร้างรูป" → web_research + image_creation (2 different skills)
  "หาร้านแล้วจองใน calendar" → places + calendar_mgmt (2 different skills)
KEY: Multi-step means DIFFERENT agents/skills for DIFFERENT sub-tasks. Calling the SAME agent twice for the same question is WRONG.

AUDIO/VIDEO DEFAULT TASK (user sends media without specific instruction):
  AUDIO sent → delegate task: "Transcribe this audio message and summarize key points"
  VIDEO sent → delegate task: "Analyze this video: describe what is shown (scenes, people, actions, objects, any text) and summarize the key content"

COMBINED REQUEST in ONE delegation:
  Audio: "ถอดเสียงแล้วสรุป" / "สรุปเสียงนี้" → task: "transcribe fully AND summarize the key points"
  Video: "วิเคราะห์แล้วสรุป" / "สรุปวิดีโอ" → task: "analyze this video fully AND summarize the key content"
  The agent receives media inline — handle everything in one pass, no need for 2 delegations.

=== CRITICAL RULES ===
- FACTS & NEWS: For ANY question about facts, news, current events, sports, weather, prices — ALWAYS delegate to an agent with web_search. NEVER answer from your own knowledge — your training data is outdated.
- MEMORY: For questions about the user (name, preferences, past conversations) — ALWAYS check memory context AND use memory_search/memory_get tools before responding. NEVER say "I don't know" without searching first.
- SCHEDULING: When the user says "อีก X นาที", "เดี๋ยว", "ตอน X โมง", or ANY delayed request — call the cron tool RIGHT NOW. NEVER just promise in text.
- CALENDAR: For ANY calendar request, delegate to an agent with calendar_mgmt skill. The google_link tool ONLY handles OAuth linking.
- QUESTION vs COMMAND: "เราสามารถ...ได้ไหม", "มีทางทำ...ได้มั้ย", "เป็นไปได้ไหม", "ทำได้มั้ย", "Can we...?", "Is it possible to...?" = user is ASKING if something is possible → respond_directly with a conversational answer (yes/no + brief explanation + ask if they want to proceed). Do NOT delegate immediately.
- SEARCH/CREATE: Only when user gives a direct ACTION command ("สร้าง", "ทำ", "ช่วยทำ", "เขียน", "หา", "generate", "build", "create") without question form — call delegate_task RIGHT NOW. NEVER just say "I'll do it" as text.
- RETRY: "ทำต่อ", "ลองอีกที", "ทำใหม่" = retry the previous creation task. Delegate immediately.
- TTS: ONLY when the user gives a COMMAND to produce audio. TTS commands: "ให้ฟัง", "อ่านให้ฟัง", "พูดให้ฟัง", "อ่านออกเสียง", "ออกเสียงให้ฉัน/ให้ผม/ให้หน่อย". If data must be fetched first, plan multi-step: fetch → TTS. If text is already available, delegate to TTS agent directly.
  NOT TTS — return TEXT instead: "ออกเสียงยังไง", "ออกเสียงอย่างไร", "ออกเสียงว่าอะไร" (questions about pronunciation → explain in text). "อ่านเอกสาร", "อ่านรูป", "อ่านไฟล์", "อ่านข้อความ" (user wants TEXT extraction/OCR).
- CALCULATE: Math, percentages, unit conversions (km↔miles, °C↔°F, THB↔USD, kg↔lbs) — answer DIRECTLY without delegating. You can compute these natively. Only delegate if the user needs real-time exchange rates (use web_search).
- OCR / TEXT FROM IMAGE: "อ่านตัวอักษร", "อ่านข้อความในรูป", "สแกนใบเสร็จ", "อ่านป้าย", "OCR" + image → delegate to agent with ocr/image_analysis skill. Do NOT try to read image text yourself as orchestrator.
- TODO: "เพิ่มงาน", "รายการงาน", "to-do", "สิ่งที่ต้องทำ", "จดไว้ว่าต้องทำ" → delegate to agent with todo skill.
- EXPENSE/INCOME: "บันทึกค่าใช้จ่าย", "จ่ายไปกี่บาท", "รายจ่าย", "รายได้" → delegate to agent with expense skill.
- HEALTH: "บันทึกน้ำหนัก", "วันนี้วิ่ง", "นอนกี่ชั่วโมง", "แคล" → delegate to agent with health skill.
- NEWS DIGEST / DAILY SUMMARY: "สรุปข่าวทุกเช้า", "ส่งข่าวให้ทุกวัน" → use cron tool with taskType="ai", the cron AI will search + push to user automatically.
- STOCK/CRYPTO: "ราคาหุ้น", "ราคาคริปโต", "BTC", "SET index" → delegate to web_search agent for real-time prices.
- NO PROMISES: Never use respond_directly to say "I'll search for you" or "Let me create..." — call the actual tool (delegate_task, cron, etc.) instead. Only call respond_directly when you have a real answer to give.
- NO TOOLS YOU DON'T HAVE: If you don't have the right tool, delegate or tell the user honestly.

=== USER PROFILE ===
Learn and remember user preferences using the user_profile tool.
SAVE immediately when the user explicitly states a personal fact:
- "ชื่อมนนะ" → user_profile(set, key="name", value="มน")
- "เรียกเราว่าบอสก็ได้" → user_profile(set, key="nickname", value="บอส")
- "ชอบกินส้มตำ" / "ผมเป็นแฟนแมนยู" / "ทำงานเป็น developer" → save the preference
- "ไม่ชอบ K-pop" / "แพ้ถั่ว" → save dislikes/important facts too
DO NOT save from one-off questions or casual mentions:
- "ผลบอลแมนยูเป็นไง" (question ≠ being a fan) / "หาร้านส้มตำหน่อย" (ordering ≠ favorite food)
Always complete the user's main request FIRST, then save profile if applicable.

=== DELEGATION GUIDELINES ===
- ALWAYS include the exact current date in the task (today is ${now}, year ${ceYear} CE / พ.ศ. ${beYear})
- Provide clear, complete task descriptions with all relevant context from conversation
- After receiving results, relay naturally — no raw JSON, no unnecessary commentary
- If error, explain simply and suggest alternatives
- Thai user → instruct agent to prioritize Thai sources (YouTube TH, Thai news, "search_lang: th, country: TH")
- "คลิป"/"วิดีโอ" → instruct agent to search YouTube and include URL(s)
- Relative dates → use get_datetime tool to resolve before delegating
- Item references ("อันแรก", "ฉบับที่ 2") → use data from the MOST RECENT result in conversation

=== FOLLOW-UP ABOUT PREVIOUS MEDIA ===
When user asks about media from a PREVIOUS message (e.g. "ข้อ 5 ละ", "สรุปให้หน่อย", "นกสีอะไร"):
1. CHECK conversation history — find the previous analysis entry [Video messageId=XXX: ...] or [Image messageId=XXX: ...]
2. If the answer IS already in the history → respond DIRECTLY without delegating
3. If the answer is NOT in the history (e.g. asked about a detail the first analysis didn't cover):
   - Extract the messageId from the history entry
   - Call delegate_task with mediaMessageId="XXX" to re-fetch and re-analyze for the specific question
   - Example: user asks "นกสีอะไร" → history shows [Video messageId=12345: ...no color mentioned...] → delegate_task(agentId=..., task="Re-analyze this video: what color is the bird?", mediaMessageId="12345")
EXCEPTION: "อ่านให้ฟัง" = TTS request. Plan multi-step if data must be fetched first.

=== GOOGLE ACCOUNT LINKING ===
When agent returns "google_not_linked", use google_link tool to generate a linking URL.

=== HOW TO DELEGATE ===
Step 1: Identify what SKILL the user's request needs.
Step 2: Find the skill below → read "DELEGATE TO" to get the agentId.
Step 3a: If the request needs action → Call delegate_task(agentId="...", task="...") immediately.
Step 3b: If no tool action needed → Call respond_directly(text="...") immediately.
Never output raw text — always call a tool.

${agentCatalog}`;
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
  videoUrl?: string;
}

// Audio result จาก TTS tool (set ระหว่าง agent loop, อ่านหลัง loop จบ)
type AudioResult = { url: string; duration: number };

/** เช็ค tool result ว่ามี audioUrl หรือ imageUrl มั้ย (เรียกหลัง executeTool) — ใช้ local state */
function checkToolResultForMedia(result: string, state: ChatState): void {
  try {
    const parsed = JSON.parse(result);
    if (parsed.audioUrl && parsed.success) {
      state.lastAudioResult = { url: parsed.audioUrl, duration: parsed.duration || 0 };
      console.log(`[AI] Audio detected from TTS tool: ${parsed.audioUrl}`);
    }
    if (parsed.imageUrl && parsed.success) {
      state.lastImageUrl = parsed.imageUrl;
      console.log(`[AI] Image detected: ${parsed.imageUrl}`);
    }
    if (parsed.videoUrl && parsed.success) {
      state.lastVideoUrl = parsed.videoUrl;
      console.log(`[AI] Video detected: ${parsed.videoUrl}`);
    }
  } catch { /* not JSON, ignore */ }
}

/**
 * Core agent loop (do-until) + Memory System
 * @param options.skipHistory - true = ไม่โหลด/บันทึก history (สำหรับ background tasks เช่น cron AI)
 */
export interface ChatOptions {
  skipHistory?: boolean;
  agentId?: string;      // ระบุ agent ปลายทาง (สำหรับ delegation)
  isDelegate?: boolean;  // ข้าม orchestrator mode, ใช้ tools ของ agent ตรงๆ
  useOrchestrator?: boolean;  // บังคับใช้ orchestrator mode (สำหรับ cron AI tasks)
}

export async function chat(userId: string, message: string, media?: MediaData, options?: ChatOptions): Promise<ChatResult> {
  const primaryProvider = getAIProvider();
  if (primaryProvider === "none") {
    return { text: "ยังไม่ได้ตั้งค่า AI provider กรุณาใส่ getGeminiKey(), getOllamaModel() หรือ ANTHROPIC_API_KEY ใน .env" };
  }

  // ===== 3 โหมด: orchestrator / delegate / legacy =====
  const skip = options?.skipHistory ?? false;
  const isDelegate = options?.isDelegate ?? false;
  const isOrchestratorMode = !isDelegate && (!skip || options?.useOrchestrator); // ปกติ = orchestrator, skip (cron/spawn) = legacy ยกเว้นมี useOrchestrator

  let activeAgent: AgentConfig | undefined;
  let agentSkills: Array<SkillConfig & { priority: number }> = [];
  let filteredTools = getToolDefinitions(); // default: all tools
  let orchestratorSystemPrompt: string | undefined; // ใช้เฉพาะโหมด orchestrator

  try {
    if (isDelegate && options?.agentId) {
      // โหมด delegate: โหลด agent เฉพาะ → ใช้ tools ตาม skills (ไม่มี delegate_task)
      activeAgent = getAgent(memoryConfig.dataDir, options.agentId) ?? getActiveAgent(memoryConfig.dataDir);
      agentSkills = getAgentSkills(memoryConfig.dataDir, activeAgent.id);
      if (agentSkills.length > 0) {
        const allowedToolNames = new Set<string>();
        for (const skill of agentSkills) {
          for (const t of skill.tools) allowedToolNames.add(t);
        }
        filteredTools = getToolDefinitions().filter(
          (t) => allowedToolNames.has(t.name) && t.name !== "delegate_task",
        );
      } else {
        filteredTools = [];
      }
      console.log(`[AI] Delegate mode → agent "${activeAgent.name}" | Tools: ${filteredTools.length}`);

    } else if (isOrchestratorMode) {
      // โหมด orchestrator: ไม่ผูกกับ agent ใดๆ — ใช้ Gemini env key เสมอ
      // activeAgent = undefined (ไม่โหลด DEFAULT agent)

      // โหลด orchestrator config จาก DB (id='00') — ชื่อ, system prompt, allowed tools
      const orchConfig = getOrchestratorAgent(memoryConfig.dataDir);

      // Tools: อ่านจาก DB ถ้ามี, fallback เป็น default set
      const defaultOrchestratorTools = ["delegate_task", "get_datetime", "memory_search", "memory_get", "google_link", "cron", "user_profile"];
      const orchestratorToolNames = new Set(orchConfig.allowedTools ?? defaultOrchestratorTools);
      filteredTools = [...getToolDefinitions().filter((t) => orchestratorToolNames.has(t.name)), RESPOND_DIRECTLY_TOOL];
      const allAgents = listAgentsWithSkills(memoryConfig.dataDir);
      // ถ้ามี custom system_prompt ใน DB → ใช้เลย, ไม่งั้น → auto-generate
      orchestratorSystemPrompt = orchConfig.systemPrompt || getOrchestratorPrompt(allAgents, orchConfig.name);

      console.log(`[AI] Orchestrator "${orchConfig.name}" | Agents: ${allAgents.filter((a) => a.enabled).length} | Tools: ${filteredTools.length}`);

    } else {
      // โหมด legacy (cron/spawn): เหมือนเดิม — ใช้ tools ทั้งหมดของ agent
      activeAgent = getActiveAgent(memoryConfig.dataDir);
      agentSkills = getAgentSkills(memoryConfig.dataDir, activeAgent.id);
      if (agentSkills.length > 0) {
        const allowedToolNames = new Set<string>();
        for (const skill of agentSkills) {
          for (const t of skill.tools) allowedToolNames.add(t);
        }
        filteredTools = getToolDefinitions().filter((t) => allowedToolNames.has(t.name));
      } else {
        filteredTools = [];
      }
      const skillNames = agentSkills.map((s) => s.name).join(", ");
      console.log(`[AI] Legacy mode → agent "${activeAgent.name}" | Skills: ${skillNames || "none"} | Tools: ${filteredTools.length}`);
    }
  } catch { /* agent tables not ready yet, use defaults */ }

  // Track active task for admin dashboard
  if (isDelegate) {
    updateTask(userId, { agent: options?.agentId || activeAgent?.id || "unknown", step: "thinking" });
  } else {
    startTask(userId, isOrchestratorMode ? "orchestrator" : (activeAgent?.id || "default"), message.substring(0, 80));
  }

  // เลือก provider:
  // - Orchestrator: ใช้ Gemini จาก env GEMINI_API_KEY เสมอ (ไม่ผ่าน agent ใดๆ)
  // - Delegate (agent): ใช้ provider ของ agent นั้นๆ (ส่วนใหญ่เป็น OpenRouter)
  let provider = primaryProvider;
  if (isOrchestratorMode) {
    // Orchestrator always uses Gemini from env — ไม่ผ่าน agent ใดๆ
    provider = "gemini";
    if (!getGeminiKey()) {
      return { text: "กรุณาตั้งค่า GEMINI_API_KEY ใน .env สำหรับ orchestrator" };
    }
    console.log(`[AI] Orchestrator using Gemini (env key)`);
  } else if (isDelegate && activeAgent) {
    const agentProvider = activeAgent.provider;
    // Agent มี API key ของตัวเอง → ถือว่า ready เสมอ
    const hasOwnKey = !!activeAgent.apiKey;
    const available = hasOwnKey || getAvailableProviders().find((p) => p.id === agentProvider && p.ready);
    if (available) {
      provider = agentProvider;
      console.log(`[AI] Delegate using agent provider: ${getProviderLabel(agentProvider)}${hasOwnKey ? " (own API key)" : ""}`);
    } else {
      console.log(`[AI] Agent provider "${agentProvider}" not available, falling back to ${getProviderLabel(primaryProvider)}`);
    }
  }

  // 1. โหลด history จาก DB (skip สำหรับ background tasks)
  const dbHistory = skip ? [] : loadHistory(userId, MAX_HISTORY, memoryConfig);

  // 2. ค้นหา memory ที่เกี่ยวข้อง (hybrid search)
  // skip memory สำหรับ delegate mode — agent ทำงานเฉพาะ task ไม่ต้องการบริบทจาก memory
  let memoryContext = "";
  if (!isDelegate) {
    try {
      const results = await searchMemory(message, userId, memoryConfig);
      memoryContext = formatMemoryForPrompt(results);
      if (memoryContext) {
        console.log(`[memory] Found ${results.length} relevant memories for "${message.substring(0, 50)}"`);
      } else {
        console.log(`[memory] No relevant memories found for "${message.substring(0, 50)}"`);
      }
    } catch (err) {
      console.error("[memory] Search failed:", err);
    }
  }

  // 3. ประกอบ system prompt + profile + memory context
  // Media ทุกแบบ (image/audio/video) → ผ่าน orchestrator เสมอ → delegate ไปให้ agent ที่มี skill
  // Orchestrator ไม่เห็น media inline — เห็นแค่ text description → ต้อง delegate
  const basePrompt = orchestratorSystemPrompt || getSystemPrompt(activeAgent, agentSkills);

  // Load user profile (structured data — lightweight, always inject for orchestrator/legacy)
  let profileContext = "";
  if (!isDelegate) {
    try {
      const { formatProfileForPrompt } = await import("./profile/store.js");
      profileContext = formatProfileForPrompt(memoryConfig.dataDir, userId);
    } catch (err) {
      console.error("[profile] Failed to load:", err);
    }
  }

  let fullSystemPrompt = basePrompt;
  if (profileContext) {
    fullSystemPrompt += `\n\n=== USER PROFILE ===\nThis is the current user's saved profile. Use their name/nickname when addressing them. Respect their preferences.\n\n${profileContext}`;
  }
  if (memoryContext) {
    fullSystemPrompt += `\n\n=== MEMORY CONTEXT (from past conversations) ===\nUse this to answer questions about the user (name, preferences, past topics). This data may be outdated — do NOT confuse with current facts.\n\n${memoryContext}`;
  }

  // บันทึกข้อความ user ลง DB + index เข้า memory
  // ถ้ามี media → รอ AI ตอบก่อน แล้วเก็บ enriched message พร้อม description
  if (!skip && !media) {
    saveMessage(userId, "user", message, memoryConfig).catch(console.error);
  }

  let reply: string;

  // Per-request state — local ไม่ share ระหว่าง users (แก้ race condition จาก global vars เดิม)
  const state: ChatState = { toolCallCount: 0 };

  console.log(`[AI] Using: ${getProviderLabel(provider, activeAgent?.model)}`);

  if (provider === "gemini") {
    try {
      // Orchestrator ใช้ env key เสมอ — ห้าม pass per-agent key
      const agentApiKey = isDelegate ? (activeAgent?.apiKey || undefined) : undefined;
      const trackingAgentId = isDelegate ? activeAgent?.id : "orchestrator";
      // Orchestrator mode: ไม่ส่ง media inline → บังคับให้ delegate ไปให้ agent ที่มี skill
      // media เก็บใน contextMedia (param 7) → delegate_task forward ให้ agent ได้
      // Agent (isDelegate): ส่ง media inline ปกติ → วิเคราะห์ตรง
      const inlineMedia = (isOrchestratorMode && !isDelegate && media) ? undefined : media;
      // Orchestrator: force tool call (mode=ANY) — ต้อง call respond_directly หรือ tool อื่นเสมอ
      // Agent (isDelegate): ไม่บังคับ — ตอบ text ตรงได้
      const forceOrchestrator = isOrchestratorMode && !isDelegate;
      reply = await chatGemini(message, dbHistory, fullSystemPrompt, userId, inlineMedia, filteredTools, media, trackingAgentId, agentApiKey, state, forceOrchestrator);

      // Gemini บางทีคืน empty → retry ด้วย reduced context (ลด history + ตัด memory)
      if (reply === "(no response from Gemini)" || reply === "(no response)") {
        const reducedHistory = dbHistory.slice(-5);
        console.log(`[AI] Empty response, retrying with reduced context (history: ${dbHistory.length}→${reducedHistory.length}, no memory)...`);
        reply = await chatGemini(message, reducedHistory, basePrompt, userId, inlineMedia, filteredTools, media, trackingAgentId, agentApiKey, state);
      }

      // ยัง empty อีก → fallback (audio/video ใช้ fallback ไม่ได้ — เฉพาะ Gemini process ได้)
      if (reply === "(no response from Gemini)" || reply === "(no response)") {
        const fallback = await handleGeminiFailure("empty", media, message, dbHistory, fullSystemPrompt, userId, filteredTools, activeAgent, state);
        if (fallback) reply = fallback;
      }
    } catch (err: any) {
      const fallback = await handleGeminiFailure("error", media, message, dbHistory, fullSystemPrompt, userId, filteredTools, activeAgent, state, err?.message?.substring(0, 80));
      if (fallback) reply = fallback;
      else throw err;
    }
  } else if (provider === "openrouter") {
    const model = activeAgent?.model || "google/gemini-2.5-flash";
    const trackingAgentId = isDelegate ? activeAgent?.id : "orchestrator";
    reply = await chatOpenRouter(message, dbHistory, fullSystemPrompt, userId, media, filteredTools, model, trackingAgentId, state);
  } else if (provider === "ollama") {
    reply = await chatOllama(message, dbHistory, fullSystemPrompt, userId, media, filteredTools, state);
  } else {
    reply = await chatAnthropic(message, dbHistory, fullSystemPrompt, userId, media, filteredTools, state);
  }

  // ถ้ามี media → เก็บ user message พร้อม AI description/transcript (เหมือน OpenClaw)
  if (!skip && media) {
    const mediaType = media.mimeType.startsWith("image/") ? "Image"
      : media.mimeType.startsWith("video/") ? "Video"
      : media.mimeType.startsWith("audio/") ? "Audio"
      : "Media";
    const desc = reply.length > 2000
      ? reply.substring(0, 2000).replace(/\n/g, " ")
      : reply.replace(/\n/g, " ");
    // เก็บ messageId ด้วย (ถ้ามี) เพื่อให้ AI สามารถ reference re-download ได้จาก history
    const msgIdMatch = message.match(/messageId=(\d+)/);
    const msgIdPart = msgIdMatch ? ` messageId=${msgIdMatch[1]}` : "";
    saveMessage(userId, "user", `[${mediaType}${msgIdPart}: ${desc}]`, memoryConfig).catch(console.error);
  }

  // Replace technical empty-response messages with user-friendly text
  // ถ้ามีผลลัพธ์จาก tool อยู่แล้ว (audio/image/video) → ไม่บอก error เพราะงานสำเร็จแล้ว
  if (reply === "(no response from Gemini)" || reply === "(no response)") {
    if (state.lastAudioResult || state.lastImageUrl || state.lastVideoUrl) {
      reply = "";  // มีผล → ส่ง media ได้เลย orchestrator จัดการเอง
    } else {
      reply = "ขอโทษค่ะ ระบบมีปัญหาชั่วคราว ลองส่งข้อความอีกครั้งนะคะ 🙏";
      console.error(`[AI] Sending friendly error to user (original: empty response)`);
    }
  }

  // บันทึกคำตอบ AI ลง DB + index เข้า memory (skip สำหรับ background tasks)
  if (!skip) {
    saveMessage(userId, "assistant", reply, memoryConfig).catch(console.error);
  }

  const result: ChatResult = { text: reply };
  if (state.lastAudioResult) {
    result.audioUrl = state.lastAudioResult.url;
    result.audioDuration = state.lastAudioResult.duration;
  }
  if (state.lastImageUrl) {
    result.imageUrl = state.lastImageUrl;
  }
  if (state.lastVideoUrl) {
    result.videoUrl = state.lastVideoUrl;
  }
  return result;
}


// ===== Fallback: parse tool call from text =====
// Some models (DeepSeek, etc.) output tool calls as text instead of proper function calls.
// Supports: JSON format {"name":"...", "arguments":{...}} and XML format <functioninvoke name="..." ...>
function parseToolCallFromText(
  text: string,
): { name: string; args: Record<string, unknown> } | null {
  if (!text) return null;

  // 1. JSON format: {"name":"tool_name", "arguments":{...}}
  try {
    const jsonMatch = text.match(/\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})[\s\S]*?\}/);
    if (jsonMatch) {
      const name = jsonMatch[1];
      const args = JSON.parse(jsonMatch[2]);
      if (findTool(name)) return { name, args };
    }
  } catch { /* ignore */ }

  // 2. XML format: <functioninvoke name="tool_name"> or <tool_call><name>...</name><arguments>...</arguments></tool_call>
  try {
    // DeepSeek style: <functioninvoke name="web_search" params='{"query":"..."}'>
    const xmlMatch = text.match(/<functioninvoke\s+name="([^"]+)"[^>]*params='(\{[^']*\})'[^>]*>/);
    if (xmlMatch) {
      const name = xmlMatch[1];
      const args = JSON.parse(xmlMatch[2]);
      if (findTool(name)) return { name, args };
    }
    // Alt XML: <functioninvoke name="..." params="{...}"> (double quotes in params)
    const xmlMatch2 = text.match(/<functioninvoke\s+name="([^"]+)"[^>]*params="(\{[^"]*\})"[^>]*>/);
    if (xmlMatch2) {
      const name = xmlMatch2[1];
      const args = JSON.parse(xmlMatch2[2].replace(/&quot;/g, '"'));
      if (findTool(name)) return { name, args };
    }
    // Generic XML: <tool_call>...<name>X</name>...<arguments>{...}</arguments>...</tool_call>
    const xmlMatch3 = text.match(/<tool_call>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<arguments>([\s\S]*?)<\/arguments>[\s\S]*?<\/tool_call>/);
    if (xmlMatch3) {
      const name = xmlMatch3[1].trim();
      const args = JSON.parse(xmlMatch3[2].trim());
      if (findTool(name)) return { name, args };
    }
  } catch { /* ignore */ }

  return null;
}

// ===== Gemini Failure Fallback (consolidated — ใช้ทั้ง empty response + catch block) =====
async function handleGeminiFailure(
  reason: "empty" | "error",
  media: MediaData | undefined,
  message: string,
  dbHistory: Array<{ role: string; content: string }>,
  fullSystemPrompt: string,
  userId: string,
  filteredTools: ReturnType<typeof getToolDefinitions>,
  activeAgent: AgentConfig | undefined,
  state: ChatState,
  errorMsg?: string,
): Promise<string | null> {
  // Heavy media → no fallback (other providers can't handle audio/video inline)
  if (isHeavyMedia(media)) {
    const sizeMB = Math.round(media!.size / (1024 * 1024));
    const mediaWord = media!.mimeType.startsWith("audio/") ? "เสียง" : "วิดีโอ";
    console.log(`[AI] Gemini ${reason} for ${media!.mimeType} (${sizeMB}MB) — no fallback for audio/video`);
    return `ขออภัยค่ะ ไม่สามารถวิเคราะห์ไฟล์${mediaWord}นี้ได้ (${sizeMB}MB) อาจเป็นเพราะไฟล์ใหญ่หรือยาวเกินไป ลองส่งไฟล์ที่สั้นกว่านี้ดูนะคะ`;
  }
  // Text/image → try fallback provider
  const fb = getFallbackProvider();
  if (!fb) return null;
  console.log(`[AI] Gemini ${reason}${errorMsg ? ` (${errorMsg})` : ""}, falling back to ${getProviderLabel(fb)}`);
  if (fb === "openrouter") return chatOpenRouter(message, dbHistory, fullSystemPrompt, userId, media, filteredTools, activeAgent?.model, undefined, state);
  if (fb === "ollama") return chatOllama(message, dbHistory, fullSystemPrompt, userId, media, filteredTools, state);
  if (fb === "anthropic") return chatAnthropic(message, dbHistory, fullSystemPrompt, userId, media, filteredTools, state);
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
  contextMedia?: MediaData,
  agentId?: string,
  overrideApiKey?: string,
  state?: ChatState,
  forceToolCall?: boolean,
): Promise<string> {
  const apiKey = overrideApiKey || getGeminiKey();
  const toolCtx: ToolContext = { userId, agentId, lineClient, media: contextMedia ?? media };
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
  if (media && (GEMINI_INLINE_PREFIXES.some((p) => media.mimeType.startsWith(p)) || media.mimeType === "application/pdf")) {
    userParts.push({ inlineData: { mimeType: media.mimeType, data: media.buffer.toString("base64") } });
  }
  contents.push({ role: "user", parts: userParts });

  // แปลง tools เป็น Gemini functionDeclarations
  // ปิด tools เมื่อมี media (video/audio) — Gemini ทำ multimodal + tools พร้อมกันไม่ดี
  const geminiTools = toolDefs.length > 0 && !isHeavyMedia(media)
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
    if (geminiTools && forceToolCall) body.tool_config = { function_calling_config: { mode: "ANY" } };

    const url = `${GEMINI_BASE_URL}/models/${getGeminiModel()}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), // 60s timeout ป้องกัน hang
    });

    if (!res.ok) {
      const err = await res.text();
      trackGemini({ endpoint: "chat", model: getGeminiModel(), status: res.status, error: true, agentId: agentId || "orchestrator" });

      // 429 rate limit → retry once after delay
      if (res.status === 429) {
        const retryMatch = err.match(/retry.+?(\d+)s/i);
        const delaySec = retryMatch ? Math.min(parseInt(retryMatch[1]), 30) : 10;
        console.log(`[AI] 429 rate limit hit (agent: ${agentId || "orchestrator"}), retrying in ${delaySec}s...`);
        await new Promise((r) => setTimeout(r, delaySec * 1000));

        const retryRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (!retryRes.ok) {
          const retryErr = await retryRes.text();
          trackGemini({ endpoint: "chat", model: getGeminiModel(), status: retryRes.status, error: true, agentId: agentId || "orchestrator" });
          throw new Error(`Gemini API error after retry: ${retryRes.status} ${retryErr}`);
        }
        // Replace res reference — reassign json below
        const retryJson = (await retryRes.json()) as typeof json;
        trackGemini({
          endpoint: "chat", model: getGeminiModel(),
          promptTokens: retryJson.usageMetadata?.promptTokenCount,
          completionTokens: retryJson.usageMetadata?.candidatesTokenCount,
          totalTokens: retryJson.usageMetadata?.totalTokenCount,
          agentId: agentId || "orchestrator",
        });
        // Process retry response — jump to candidate extraction
        const retryCandidate = retryJson.candidates?.[0];
        if (!retryCandidate || !retryCandidate.content?.parts?.length) {
          lastText = "(no response from Gemini)";
          break;
        }
        const retryParts = retryCandidate.content.parts;
        contents.push({ role: "model", parts: retryParts as GeminiPart[] });
        const retryFunctionCalls = retryParts.filter((p) => p.functionCall);
        if (retryFunctionCalls.length > 0) {
          // respond_directly intercept
          const rdCall = retryFunctionCalls.find((p) => p.functionCall!.name === "respond_directly");
          if (rdCall) {
            lastText = (rdCall.functionCall!.args as { text?: string }).text || "";
            console.log(`[tool] respond_directly (429-retry) → "${lastText.substring(0, 80)}"`);
            break;
          }

          const responseParts: GeminiPart[] = [];
          for (const part of retryFunctionCalls) {
            const fc = part.functionCall!;
            console.log(`[tool] ${fc.name}(${JSON.stringify(fc.args)})`);
            if (state) state.toolCallCount++;
            updateTask(userId, { step: "tool_call", tool: fc.name, detail: fc.name === "delegate_task" ? (fc.args as any)?.agentId : JSON.stringify(fc.args).substring(0, 200) });
            const result = await executeTool(fc.name, fc.args, toolCtx);
            if (state) checkToolResultForMedia(result, state);
            if (fc.name !== "delegate_task" && toolCtx.agentId) {
              logAgentActivity(memoryConfig.dataDir, {
                agentId: toolCtx.agentId, type: "tool_call", userId,
                task: fc.name, detail: JSON.stringify(fc.args).substring(0, 500),
              });
            }
            responseParts.push({ functionResponse: { name: fc.name, response: { result } } });
          }
          contents.push({ role: "user", parts: responseParts });
          continue; // back to main loop
        }
        const retryText = retryParts.filter((p) => p.text).map((p) => p.text!);
        lastText = retryText.join("\n");
        break;
      }

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
      agentId: agentId || "orchestrator",
    });

    const candidate = json.candidates?.[0];
    if (!candidate || !candidate.content?.parts || candidate.content.parts.length === 0) {
      const reason = candidate?.finishReason || "no_candidate";
      const blockReason = (json as any).promptFeedback?.blockReason;
      const tokens = json.usageMetadata;
      console.error(`[AI] Empty response from Gemini — finishReason: ${reason}, blockReason: ${blockReason || "none"}, candidates: ${json.candidates?.length || 0}, promptTokens: ${tokens?.promptTokenCount || "?"}, totalTokens: ${tokens?.totalTokenCount || "?"}, content: ${JSON.stringify(candidate?.content)?.substring(0, 200)}`);
      lastText = "(no response from Gemini)";
      break;
    }

    const parts = candidate.content.parts;

    // เก็บ response ลง contents
    contents.push({ role: "model", parts: parts as GeminiPart[] });

    // เช็ค function calls
    const functionCalls = parts.filter((p) => p.functionCall);
    if (functionCalls.length > 0) {
      // respond_directly → ใช้ text เป็น reply และหยุด loop ทันที
      const rdCall = functionCalls.find((p) => p.functionCall!.name === "respond_directly");
      if (rdCall) {
        lastText = (rdCall.functionCall!.args as { text?: string }).text || "";
        console.log(`[tool] respond_directly → "${lastText.substring(0, 80)}"`);
        break;
      }

      const responseParts: GeminiPart[] = [];
      for (const part of functionCalls) {
        const fc = part.functionCall!;
        console.log(`[tool] ${fc.name}(${JSON.stringify(fc.args)})`);
        if (state) state.toolCallCount++;
        updateTask(userId, { step: "tool_call", tool: fc.name, detail: fc.name === "delegate_task" ? (fc.args as any)?.agentId : JSON.stringify(fc.args).substring(0, 200) });
        const result = await executeTool(fc.name, fc.args, toolCtx);
        if (state) checkToolResultForMedia(result, state);
        // Log tool calls (ยกเว้น delegate_task ที่ log ตัวเอง)
        if (fc.name !== "delegate_task" && toolCtx.agentId) {
          logAgentActivity(memoryConfig.dataDir, {
            agentId: toolCtx.agentId,
            type: "tool_call",
            userId,
            task: fc.name,
            detail: JSON.stringify(fc.args).substring(0, 500),
          });
        }
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

  // ถ้า model ตอบ empty แต่มีผลลัพธ์จาก tool แล้ว → ไม่ใช่ error
  if (!lastText && state?.lastAudioResult) lastText = "นี่ค่ะ 🎵";
  else if (!lastText && state?.lastImageUrl) lastText = "นี่ค่ะ";

  return lastText || "(no response from Gemini)";
}

// ===== OpenAI-compatible Provider (Ollama / OpenRouter / etc.) =====
interface OpenAICompatConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  supportsVision?: boolean;
  label?: string; // สำหรับ log เช่น "Ollama", "OpenRouter"
}

async function chatOpenAICompat(
  message: string,
  dbHistory: Array<{ role: string; content: string }>,
  systemPrompt: string,
  userId: string,
  media?: MediaData,
  toolDefs?: ReturnType<typeof getToolDefinitions>,
  config?: OpenAICompatConfig,
  agentId?: string,
  state?: ChatState,
): Promise<string> {
  const cfg = config || { baseUrl: `${getOllamaBaseUrl()}/v1`, model: getOllamaModel(), timeoutMs: 120_000, label: "Ollama" };
  const label = cfg.label || "OpenAI";
  const toolCtx: ToolContext = { userId, agentId, lineClient, media };
  const tools = toolDefs || getToolDefinitions();

  const messages: Array<any> = [
    { role: "system", content: systemPrompt },
  ];

  for (const m of dbHistory.slice(-(MAX_HISTORY - 1))) {
    messages.push({ role: m.role, content: m.content });
  }

  // User message + optional multimodal (OpenAI/OpenRouter format)
  // image → image_url, audio → input_audio, video → video_url
  const AUDIO_FORMAT: Record<string, string> = {
    "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav",
    "audio/aac": "aac", "audio/ogg": "ogg", "audio/flac": "flac",
    "audio/opus": "ogg", "audio/webm": "webm", "audio/x-ms-wma": "wav",
  };
  if (media && media.mimeType.startsWith("image/") && cfg.supportsVision !== false) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: message },
        { type: "image_url", image_url: { url: `data:${media.mimeType};base64,${media.buffer.toString("base64")}` } },
      ],
    });
  } else if (media && media.mimeType.startsWith("audio/") && cfg.supportsVision !== false) {
    const fmt = AUDIO_FORMAT[media.mimeType] || "mp3";
    messages.push({
      role: "user",
      content: [
        { type: "text", text: message },
        { type: "input_audio", input_audio: { data: media.buffer.toString("base64"), format: fmt } },
      ],
    });
  } else if (media && media.mimeType.startsWith("video/") && cfg.supportsVision !== false) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: message },
        { type: "video_url", video_url: { url: `data:${media.mimeType};base64,${media.buffer.toString("base64")}` } },
      ],
    });
  } else if (media && media.mimeType === "application/pdf" && cfg.supportsVision !== false) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: message },
        { type: "image_url", image_url: { url: `data:application/pdf;base64,${media.buffer.toString("base64")}` } },
      ],
    });
  } else {
    messages.push({ role: "user", content: message });
  }

  const oaiTools = tools.length > 0
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
      model: cfg.model,
      messages,
      max_tokens: 8192,
      stream: false,
    };
    if (oaiTools) body.tools = oaiTools;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
    if (cfg.extraHeaders) Object.assign(headers, cfg.extraHeaders);

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs || 60_000),
    });

    if (!res.ok) {
      const err = await res.text();
      trackGemini({ endpoint: "chat", model: cfg.model, status: res.status, error: true, agentId: agentId || "orchestrator" });

      // 429 rate limit → retry once after delay
      if (res.status === 429) {
        const retryMatch = err.match(/retry.+?(\d+)s/i);
        const delaySec = retryMatch ? Math.min(parseInt(retryMatch[1]), 30) : 10;
        console.log(`[${label}] 429 rate limit hit (agent: ${agentId || "orchestrator"}), retrying in ${delaySec}s...`);
        await new Promise((r) => setTimeout(r, delaySec * 1000));

        const retryRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: "POST", headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs || 60_000),
        });
        if (!retryRes.ok) {
          const retryErr = await retryRes.text();
          trackGemini({ endpoint: "chat", model: cfg.model, status: retryRes.status, error: true, agentId: agentId || "orchestrator" });
          throw new Error(`${label} API error after retry: ${retryRes.status} ${retryErr}`);
        }
        // Parse retry response and continue processing below
        const retryJson = (await retryRes.json()) as any;
        const retryChoice = retryJson.choices?.[0];
        if (!retryChoice) { lastText = "(no response)"; break; }

        trackGemini({
          endpoint: "chat", model: cfg.model,
          promptTokens: retryJson.usage?.prompt_tokens,
          completionTokens: retryJson.usage?.completion_tokens,
          totalTokens: retryJson.usage?.total_tokens,
          agentId: agentId || "orchestrator",
        });

        // Process as if it were the normal response
        const retryMsg = retryChoice.message;
        messages.push(retryMsg as any);
        if (retryMsg.tool_calls?.length > 0) {
          for (const tc of retryMsg.tool_calls) {
            const args = JSON.parse(tc.function.arguments);
            console.log(`[tool] ${tc.function.name}(${JSON.stringify(args)})`);
            if (state) state.toolCallCount++;
            updateTask(userId, { step: "tool_call", tool: tc.function.name, detail: tc.function.name === "delegate_task" ? args?.agentId : JSON.stringify(args).substring(0, 200) });
            const result = await executeTool(tc.function.name, args, toolCtx);
            if (state) checkToolResultForMedia(result, state);
            if (tc.function.name !== "delegate_task" && agentId) {
              logAgentActivity(memoryConfig.dataDir, { agentId, type: "tool_call", userId, task: tc.function.name, detail: JSON.stringify(args).substring(0, 500) });
            }
            messages.push({ role: "tool", content: result, tool_call_id: tc.id });
          }
          continue;
        }
        lastText = retryMsg.content || "";
        break;
      }

      throw new Error(`${label} API error: ${res.status} ${err}`);
    }

    const json = (await res.json()) as {
      choices: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    trackGemini({
      endpoint: "chat", model: cfg.model,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
      agentId: agentId || "orchestrator",
    });

    const choice = json.choices[0];
    if (!choice) {
      console.log(`[${label}] No choices in response:`, JSON.stringify(json).substring(0, 500));
      break;
    }
    const assistantMsg = choice.message;
    console.log(`[${label}] Response: finish=${choice.finish_reason}, content=${(assistantMsg.content || "").substring(0, 100)}, tool_calls=${assistantMsg.tool_calls?.length || 0}`);

    messages.push(assistantMsg as any);

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const tc of assistantMsg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        console.log(`[tool] ${tc.function.name}(${JSON.stringify(args)})`);
        if (state) state.toolCallCount++;
        updateTask(userId, { step: "tool_call", tool: tc.function.name, detail: tc.function.name === "delegate_task" ? args?.agentId : JSON.stringify(args).substring(0, 200) });
        const result = await executeTool(tc.function.name, args, toolCtx);
        if (state) checkToolResultForMedia(result, state);
        if (tc.function.name !== "delegate_task" && agentId) {
          logAgentActivity(memoryConfig.dataDir, { agentId, type: "tool_call", userId, task: tc.function.name, detail: JSON.stringify(args).substring(0, 500) });
        }
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }
      continue;
    }

    const textToolCall = parseToolCallFromText(assistantMsg.content || "");
    if (textToolCall) {
      console.log(`[tool/text-fallback] ${textToolCall.name}(${JSON.stringify(textToolCall.args)})`);
      if (state) state.toolCallCount++;
      updateTask(userId, { step: "tool_call", tool: textToolCall.name, detail: JSON.stringify(textToolCall.args).substring(0, 200) });
      const result = await executeTool(textToolCall.name, textToolCall.args, toolCtx);
      if (state) checkToolResultForMedia(result, state);
      messages.push({ role: "tool", content: result, tool_call_id: `fallback-${Date.now()}` });
      continue;
    }

    lastText = assistantMsg.content || "";
    break;
  }

  return lastText || "(no response)";
}

// Ollama wrapper (backward compat)
async function chatOllama(
  message: string, dbHistory: Array<{ role: string; content: string }>,
  systemPrompt: string, userId: string, media?: MediaData,
  toolDefs?: ReturnType<typeof getToolDefinitions>,
  state?: ChatState,
): Promise<string> {
  return chatOpenAICompat(message, dbHistory, systemPrompt, userId, media, toolDefs, {
    baseUrl: `${getOllamaBaseUrl()}/v1`, model: getOllamaModel(),
    timeoutMs: 120_000, label: "Ollama",
  }, undefined, state);
}

// OpenRouter wrapper
async function chatOpenRouter(
  message: string, dbHistory: Array<{ role: string; content: string }>,
  systemPrompt: string, userId: string, media?: MediaData,
  toolDefs?: ReturnType<typeof getToolDefinitions>,
  agentModel?: string, agentId?: string,
  state?: ChatState,
): Promise<string> {
  return chatOpenAICompat(message, dbHistory, systemPrompt, userId, media, toolDefs, {
    baseUrl: OPENROUTER_BASE_URL,
    model: agentModel || "google/gemini-2.5-flash",
    apiKey: getOpenRouterKey(),
    extraHeaders: {
      "HTTP-Referer": process.env.BASE_URL || "https://myclaw.app",
      "X-Title": "MyClaw",
    },
    timeoutMs: 180_000,
    supportsVision: true,
    label: "OpenRouter",
  }, agentId, state);
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
  state?: ChatState,
): Promise<string> {
  const toolCtx: ToolContext = { userId, lineClient, media };
  const history: Anthropic.MessageParam[] = dbHistory
    .slice(-(MAX_HISTORY - 1))
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  // User message + inline media
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
  } else if (media && media.mimeType === "application/pdf") {
    history.push({
      role: "user",
      content: [
        {
          type: "document" as const,
          source: {
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: media.buffer.toString("base64"),
          },
        } as any,
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
      max_tokens: 4096,
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
          if (state) state.toolCallCount++;
          updateTask(userId, { step: "tool_call", tool: block.name, detail: block.name === "delegate_task" ? (block.input as any)?.agentId : JSON.stringify(block.input).substring(0, 200) });
          const result = await executeTool(block.name, block.input as Record<string, unknown>, toolCtx);
          if (state) checkToolResultForMedia(result, state);
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
