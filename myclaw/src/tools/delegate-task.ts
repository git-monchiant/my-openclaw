/**
 * delegate_task — Orchestrator tool สำหรับส่งงานให้ agent เฉพาะทาง
 *
 * ใช้ lazy import เพื่อหลีกเลี่ยง circular dependency: delegate-task → ai → tools/index → delegate-task
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import type { MediaData } from "../media.js";
import { downloadLineMedia } from "../media.js";
import type { ChatOptions } from "../ai.js";
import { logAgentActivity } from "../agents/registry.js";
import { loadHistory, DEFAULT_MEMORY_CONFIG } from "../memory/index.js";
import { updateTask, recordTraceResult, recordTraceError } from "../admin/active-tasks.js";

// Lazy import เพื่อหลีกเลี่ยง circular dependency (pattern เดียวกับ cron.ts)
async function lazyChat(
  userId: string,
  message: string,
  media?: MediaData,
  options?: ChatOptions,
) {
  const { chat } = await import("../ai.js");
  return chat(userId, message, media, options);
}

export const delegateTaskTool: ToolDefinition = {
  name: "delegate_task",
  description:
    "Delegate a specialized task to a specific agent. Use when the user's request requires " +
    "specific capabilities (image creation, web search, TTS, browser, etc.) that a specialist agent handles. " +
    "Provide a clear task description with all relevant context. " +
    "Do NOT use this for general conversation — respond directly instead.",

  inputSchema: {
    type: "object" as const,
    properties: {
      agentId: {
        type: "string",
        description: "ID ของ agent ที่จะส่งงานให้ (จากรายชื่อ agents ใน system prompt)",
      },
      task: {
        type: "string",
        description:
          "คำอธิบายงานที่ชัดเจน รวม context ที่ agent ต้องการ เช่น ข้อความ user, " +
          "สิ่งที่ต้องทำ, รายละเอียดเพิ่มเติม",
      },
      expectedOutput: {
        type: "string",
        enum: ["text", "audio", "image", "video", "text_with_url", "any"],
        description:
          "ประเภท output ที่ต้องการรับกลับจาก agent: " +
          "text=ตอบ text, audio=สร้างเสียง (tts), image=สร้างรูป, " +
          "video=สร้างวิดีโอ, text_with_url=text พร้อม URL, any=ให้ agent ตัดสินใจ",
      },
      mediaMessageId: {
        type: "string",
        description:
          "LINE message ID ของ media เดิม (จาก history format [Video messageId=XXX: ...]) — " +
          "ใช้เมื่อต้องการ re-analyze media ที่เคยส่งมาก่อน แต่คำตอบไม่อยู่ใน history เดิม",
      },
    },
    required: ["agentId", "task"],
  },

  execute: async (
    input: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<string> => {
    const agentId = input.agentId as string;
    const task = input.task as string;
    const expectedOutput = (input.expectedOutput as string) || "any";
    const mediaMessageId = input.mediaMessageId as string | undefined;

    if (!agentId || !task) {
      return JSON.stringify({ success: false, error: "agentId and task are required" });
    }

    if (!context?.userId) {
      return JSON.stringify({ success: false, error: "no userId in context" });
    }

    console.log(`[delegate] → agent "${agentId}": ${task.substring(0, 100)}...`);

    const dataDir = process.env.DATA_DIR || "./data";
    logAgentActivity(dataDir, {
      agentId,
      type: "delegate",
      userId: context.userId,
      task: task.substring(0, 200),
    });

    try {
      // Forward media จาก context (ถ้ามี) ให้ agent ปลายทาง
      let media = context.media as MediaData | undefined;

      // สร้าง task message พร้อม context
      let enrichedTask = task;

      // ถ้าไม่มี media ใน context แต่มี mediaMessageId → re-download จาก LINE API เพื่อ re-analyze
      if (!media && mediaMessageId) {
        const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        if (token) {
          try {
            console.log(`[delegate] Re-downloading media messageId=${mediaMessageId} for re-analysis`);
            media = await downloadLineMedia(mediaMessageId, token, 10 * 1024 * 1024);
            console.log(`[delegate] Re-downloaded: ${media.mimeType}, ${Math.round(media.size / 1024)}KB`);
          } catch (err: any) {
            console.warn(`[delegate] Re-download failed for messageId=${mediaMessageId}: ${err?.message}`);
            enrichedTask = `[SYSTEM: Attempted to re-fetch LINE media messageId=${mediaMessageId} but failed (may have expired). Inform user the media is no longer available.]\n\n${enrichedTask}`;
          }
        }
      }

      // เพิ่ม recent conversation history ให้ agent มีบริบท (last 5 messages)
      try {
        const memConfig = { ...DEFAULT_MEMORY_CONFIG, dataDir: process.env.DATA_DIR || "./data" };
        const recentHistory = loadHistory(context.userId, 5, memConfig);
        if (recentHistory.length > 0) {
          const historyText = recentHistory
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.substring(0, 300)}`)
            .join("\n");
          enrichedTask = `[Recent conversation context:\n${historyText}]\n\nTask: ${task}`;
        }
      } catch { /* non-critical */ }

      // บอก agent ว่า orchestrator ต้องการ output ประเภทไหน
      const outputHints: Record<string, string> = {
        audio:        "[Expected output: audio — call the tts tool with the full text. Do not add explanatory text before or after.]",
        image:        "[Expected output: image — call the image creation tool. Do not add explanatory text before or after.]",
        video:        "[Expected output: video — call the video creation tool. Return the video URL in your response.]",
        text_with_url:"[Expected output: text with URL — reply with text that includes the relevant URL.]",
        text:         "[Expected output: text only — reply with text directly, no tool calls needed.]",
      };
      if (expectedOutput !== "any" && outputHints[expectedOutput]) {
        enrichedTask = `${outputHints[expectedOutput]}\n\n${enrichedTask}`;
      }

      // บอก agent ว่ามี media แนบมา (ไม่งั้น agent จะไม่รู้ว่ามีไฟล์อยู่จริง)
      if (media) {
        const mediaType = media.mimeType.startsWith("video/") ? "video"
          : media.mimeType.startsWith("audio/") ? "audio"
          : media.mimeType.startsWith("image/") ? "image"
          : "file";
        enrichedTask = `[A ${mediaType} file (${media.mimeType}, ${Math.round(media.size / 1024)}KB) is attached to this message. You can see/hear it directly — analyze it using your multimodal capabilities.]\n\n${enrichedTask}`;
      }

      updateTask(context.userId, { agent: agentId, step: "delegating", detail: task.substring(0, 80) });

      const delegateStart = Date.now();
      const result = await lazyChat(context.userId, enrichedTask, media, {
        agentId,
        isDelegate: true,
        skipHistory: true, // ไม่บันทึก history แยก — orchestrator จัดการเอง
      });

      const delegateElapsed = Date.now() - delegateStart;
      console.log(`[delegate] ← agent "${agentId}": ${result.text.substring(0, 100)}...`);

      // ตรวจจับ broken tool call — agent พยายาม call tool แต่ส่งออกมาเป็น text ที่เพี้ยน
      const brokenToolCall = /(?:function_calls>|<invoke\s|<tool_call>|functioninvoke|<parameter\s)/.test(result.text);
      if (brokenToolCall) {
        console.log(`[delegate] agent "${agentId}" returned broken tool call as text, treating as error`);
        recordTraceError(context.userId, agentId, "broken tool call output");
        updateTask(context.userId, { agent: "orchestrator", step: "thinking", tool: undefined, detail: undefined });
        return JSON.stringify({
          success: false,
          agentId,
          error: "Agent failed to execute the task (model output broken tool call). Please retry with a clearer query.",
        });
      }

      // บันทึกผลลงใน trace
      recordTraceResult(context.userId, agentId, result.text, delegateElapsed);

      // กลับสู่ orchestrator
      updateTask(context.userId, { agent: "orchestrator", step: "thinking", tool: undefined, detail: undefined });

      logAgentActivity(dataDir, {
        agentId,
        type: "response",
        userId: context.userId,
        task: "delegate_result",
        detail: result.text.substring(0, 500),
      });

      // Return format ที่ checkToolResultForMedia() จับได้อัตโนมัติ
      return JSON.stringify({
        success: true,
        agentId,
        text: result.text,
        ...(result.audioUrl && { audioUrl: result.audioUrl, duration: result.audioDuration || 0 }),
        ...(result.imageUrl && { imageUrl: result.imageUrl }),
        ...(result.videoUrl && { videoUrl: result.videoUrl }),
      });
    } catch (err: any) {
      console.error(`[delegate] agent "${agentId}" error:`, err);
      recordTraceError(context.userId, agentId, err?.message || "delegation failed");

      logAgentActivity(dataDir, {
        agentId,
        type: "response",
        userId: context.userId,
        task: "delegate_error",
        detail: err?.message || "delegation failed",
        status: "error",
      });

      return JSON.stringify({
        success: false,
        agentId,
        error: err?.message || "delegation failed",
      });
    }
  },
};
