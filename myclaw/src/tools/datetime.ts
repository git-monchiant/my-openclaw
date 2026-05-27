import type { ToolDefinition } from "./types.js";

/**
 * ตัวอย่าง tool: ดูวันที่/เวลาปัจจุบัน
 * ใช้เป็น template สำหรับสร้าง tool ใหม่
 */
export const datetimeTool: ToolDefinition = {
  name: "get_datetime",
  description: "Get current date and time",
  inputSchema: {
    type: "object" as const,
    properties: {
      timezone: {
        type: "string",
        description: 'Timezone (e.g. "Asia/Bangkok"). Defaults to Asia/Bangkok.',
      },
    },
    required: [],
  },
  execute: async (input) => {
    const tz = (input.timezone as string) || "Asia/Bangkok";
    const now = new Date().toLocaleString("th-TH", { timeZone: tz });
    return `Current date/time (${tz}): ${now}`;
  },
};
