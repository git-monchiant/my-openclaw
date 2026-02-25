/**
 * gmail tool — Read, send, and manage email via Gmail API
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { google } from "googleapis";
import { getUserGoogleAuth } from "./google-auth.js";

function decodeBody(body: any): string {
  if (!body?.data) return "";
  return Buffer.from(body.data, "base64url").toString("utf-8");
}

function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.substring(0, max) + "..." : s;
}

/** Encode non-ASCII header value as RFC 2047 MIME encoded-word (Base64) */
function encodeHeader(value: string): string {
  // If pure ASCII, no encoding needed
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return "=?UTF-8?B?" + Buffer.from(value, "utf-8").toString("base64") + "?=";
}

export const gmailTool: ToolDefinition = {
  name: "gmail",
  description: `Manage Gmail: read inbox, search, send, reply, label, archive.
Actions: inbox, search, read, send, reply, label, archive.
Requires Google OAuth2 configured.

IMPORTANT — when the user asks to see their emails:
1. First call "inbox" (or "search") to get the list
2. Then call "read" for EACH email to get the full body/content
3. Present results naturally like a friend summarizing — NOT as JSON or structured data
- For each email: who sent it, subject, and a brief summary of the actual content in 1-2 sentences
- Use the user's language (Thai if they speak Thai)
- Skip technical details (message IDs, labels, threadId, raw timestamps) — users don't care
- Example: "เมลล่าสุด 3 ฉบับค่ะ:\n1. จาก Amazon — ยืนยันคำสั่งซื้อหูฟัง จะส่งถึงวันศุกร์\n2. จาก หัวหน้า — ถามเรื่อง meeting พรุ่งนี้ ขอให้เตรียม slides ด้วย\n3. จาก Netflix — แจ้งต่ออายุสมาชิกอัตโนมัติเดือนหน้า ราคา 419 บาท"`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["inbox", "search", "read", "send", "reply", "label", "archive"], description: "Action" },
      query: { type: "string", description: "Search query (Gmail syntax, for search action)" },
      message_id: { type: "string", description: "Message ID (for read/reply/label/archive)" },
      to: { type: "string", description: "Recipient email (for send)" },
      subject: { type: "string", description: "Email subject (for send)" },
      body: { type: "string", description: "Email body text (for send/reply)" },
      label: { type: "string", description: "Label name (for label action)" },
      add_label: { type: "boolean", description: "true=add label, false=remove (default: true)" },
      max_results: { type: "number", description: "Max results (default: 10, max: 20)" },
    },
    required: ["action"],
  },

  async execute(input, context?: ToolContext) {
    const auth = getUserGoogleAuth(context?.userId || "");
    if (!auth) {
      return JSON.stringify({
        error: "google_not_linked",
        message: "Google account is not linked. แนะนำให้ user เชื่อมต่อ Google Account ก่อน โดยใช้ google_link tool สร้าง URL ให้ user กดเชื่อมต่อ",
        action_required: "google_link",
      });
    }

    // Auto-detect action if AI forgot to include it
    let action = input.action as string;
    if (!action) {
      if (input.to && input.subject) action = "send";
      else if (input.message_id && input.body) action = "reply";
      else if (input.message_id && input.label) action = "label";
      else if (input.message_id) action = "read";
      else if (input.query) action = "search";
      else action = "inbox";
    }
    const gmail = google.gmail({ version: "v1", auth });

    try {
      switch (action) {
        case "inbox":
        case "search": {
          const query = action === "inbox" ? "in:inbox" : (input.query as string || "in:inbox");
          const maxResults = Math.min(20, Math.max(1, Number(input.max_results) || 10));

          const list = await gmail.users.messages.list({
            userId: "me",
            q: query,
            maxResults,
          });

          const messages = list.data.messages || [];
          if (!messages.length) return JSON.stringify({ messages: [], total: 0, query });

          const details = await Promise.all(
            messages.map(async (m) => {
              const msg = await gmail.users.messages.get({
                userId: "me",
                id: m.id!,
                format: "metadata",
                metadataHeaders: ["From", "To", "Subject", "Date"],
              });
              const headers = msg.data.payload?.headers || [];
              return {
                id: m.id,
                from: getHeader(headers, "From"),
                to: getHeader(headers, "To"),
                subject: getHeader(headers, "Subject"),
                date: getHeader(headers, "Date"),
                snippet: msg.data.snippet || "",
                labels: msg.data.labelIds || [],
              };
            }),
          );

          return JSON.stringify({ messages: details, total: list.data.resultSizeEstimate || details.length, query });
        }

        case "read": {
          const id = input.message_id as string;
          if (!id) return JSON.stringify({ error: "message_id is required" });

          const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
          const headers = msg.data.payload?.headers || [];
          let body = "";

          // Extract text body
          const payload = msg.data.payload;
          if (payload?.body?.data) {
            body = decodeBody(payload.body);
          } else if (payload?.parts) {
            const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
            const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
            if (textPart?.body) body = decodeBody(textPart.body);
            else if (htmlPart?.body) body = decodeBody(htmlPart.body).replace(/<[^>]+>/g, "");
          }

          return JSON.stringify({
            id: msg.data.id,
            threadId: msg.data.threadId,
            from: getHeader(headers, "From"),
            to: getHeader(headers, "To"),
            subject: getHeader(headers, "Subject"),
            date: getHeader(headers, "Date"),
            body: truncate(body),
            labels: msg.data.labelIds || [],
          });
        }

        case "send": {
          const to = input.to as string;
          const subject = input.subject as string;
          const body = input.body as string;
          if (!to || !subject || !body) return JSON.stringify({ error: "to, subject, body are required" });

          const raw = Buffer.from(
            `To: ${to}\r\nSubject: ${encodeHeader(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
          ).toString("base64url");

          const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
          return JSON.stringify({ success: true, id: sent.data.id, threadId: sent.data.threadId });
        }

        case "reply": {
          const id = input.message_id as string;
          const body = input.body as string;
          if (!id || !body) return JSON.stringify({ error: "message_id and body are required" });

          const orig = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject", "Message-ID"] });
          const headers = orig.data.payload?.headers || [];
          const replyTo = getHeader(headers, "From");
          const subject = getHeader(headers, "Subject");
          const messageId = getHeader(headers, "Message-ID");

          const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
          const raw = Buffer.from(
            `To: ${replyTo}\r\nSubject: ${encodeHeader(reSubject)}\r\nIn-Reply-To: ${messageId}\r\nReferences: ${messageId}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
          ).toString("base64url");

          const sent = await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw, threadId: orig.data.threadId! },
          });
          return JSON.stringify({ success: true, id: sent.data.id, threadId: sent.data.threadId });
        }

        case "label": {
          const id = input.message_id as string;
          const labelName = input.label as string;
          if (!id || !labelName) return JSON.stringify({ error: "message_id and label are required" });
          const addLabel = input.add_label !== false;

          // Find or create label
          const labels = await gmail.users.labels.list({ userId: "me" });
          let label = labels.data.labels?.find((l) => l.name?.toLowerCase() === labelName.toLowerCase());
          if (!label && addLabel) {
            const created = await gmail.users.labels.create({ userId: "me", requestBody: { name: labelName } });
            label = created.data;
          }
          if (!label?.id) return JSON.stringify({ error: `Label "${labelName}" not found` });

          await gmail.users.messages.modify({
            userId: "me",
            id,
            requestBody: addLabel ? { addLabelIds: [label.id] } : { removeLabelIds: [label.id] },
          });
          return JSON.stringify({ success: true, action: addLabel ? "added" : "removed", label: labelName });
        }

        case "archive": {
          const id = input.message_id as string;
          if (!id) return JSON.stringify({ error: "message_id is required" });
          await gmail.users.messages.modify({
            userId: "me",
            id,
            requestBody: { removeLabelIds: ["INBOX"] },
          });
          return JSON.stringify({ success: true, archived: true });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const errDetail = err?.response?.data?.error?.message || err?.errors?.[0]?.message || "";
      console.error(`[gmail] ${action} error:`, errDetail || errMsg);
      return JSON.stringify({ error: errDetail || errMsg });
    }
  },
};
