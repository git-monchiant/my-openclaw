/**
 * google_link tool — Generate Google account linking URL for current user
 * AI ใช้ tool นี้สร้าง URL ส่งให้ user เมื่อยังไม่ได้เชื่อมต่อ Google
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { signSetupToken } from "../google/routes.js";
import { isUserLinked, getUserTokens } from "../google/store.js";

export const googleLinkTool: ToolDefinition = {
  name: "google_link",
  description: `Generate a Google account linking/management URL for the current user.
Use when user needs to connect or manage their Google account for Gmail, Calendar, Drive, Sheets.
Also use when any Google tool returns "google_not_linked" error.
Use "reconfigure" when user has Google linked but wants to change default calendar or has calendar issues.`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["link", "status", "reconfigure"],
        description: "link = generate setup URL, status = check if linked, reconfigure = change default calendar (default: link)",
      },
    },
    required: [],
  },

  async execute(input, context?: ToolContext) {
    if (!context?.userId) {
      return JSON.stringify({ error: "Cannot determine user" });
    }

    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) {
      return JSON.stringify({ error: "BASE_URL not configured. ส่งข้อความมาที่ LINE ก่อนเพื่อให้ระบบตรวจจับ URL อัตโนมัติ" });
    }

    const action = (input.action as string) || "link";
    const dataDir = process.env.DATA_DIR || "./data";

    if (action === "status") {
      const linked = isUserLinked(dataDir, context.userId);
      if (linked) {
        const tokens = getUserTokens(dataDir, context.userId);
        return JSON.stringify({
          linked: true,
          email: tokens?.googleEmail || "unknown",
        });
      }
      return JSON.stringify({ linked: false });
    }

    if (action === "reconfigure") {
      const linked = isUserLinked(dataDir, context.userId);
      if (!linked) {
        return JSON.stringify({ error: "not_linked", message: "ยังไม่ได้เชื่อมต่อ Google ต้อง link ก่อน" });
      }
      const token = signSetupToken(context.userId);
      const url = `${baseUrl}/google/calendars?token=${token}`;
      return JSON.stringify({
        success: true,
        url,
        message: "ส่ง URL นี้ให้ user เพื่อเลือกปฏิทินใหม่ ลิงก์มีอายุ 1 ชั่วโมง",
      });
    }

    // Generate setup URL
    const token = signSetupToken(context.userId);
    const url = `${baseUrl}/google/setup?token=${token}`;

    return JSON.stringify({
      success: true,
      url,
      message: "ส่ง URL นี้ให้ user เพื่อเชื่อมต่อ Google Account ลิงก์มีอายุ 1 ชั่วโมง",
    });
  },
};
