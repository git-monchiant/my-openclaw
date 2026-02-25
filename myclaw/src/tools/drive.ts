/**
 * drive tool — Manage Google Drive files
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { google } from "googleapis";
import { Readable } from "stream";
import { getUserGoogleAuth } from "./google-auth.js";

const MAX_DOWNLOAD_SIZE = 100_000; // 100KB text limit for download

export const driveTool: ToolDefinition = {
  name: "drive",
  description: `Manage Google Drive: list files, upload, download/read, create folders, share, delete.
Actions: list, upload, download, create_folder, share, delete.
Requires Google OAuth2 configured.`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "upload", "download", "create_folder", "share", "delete"], description: "Action" },
      // list
      query: { type: "string", description: "Search query (Drive query syntax, e.g. \"name contains 'report'\")" },
      folder_id: { type: "string", description: "Folder ID to list/upload into" },
      max_results: { type: "number", description: "Max results (default: 10, max: 50)" },
      // upload
      file_name: { type: "string", description: "File name (for upload/create_folder)" },
      content: { type: "string", description: "Text content to upload (for upload)" },
      mime_type: { type: "string", description: "MIME type (default: text/plain)" },
      // download/share/delete
      file_id: { type: "string", description: "File ID (for download/share/delete)" },
      // share
      email: { type: "string", description: "Email to share with (for share)" },
      role: { type: "string", enum: ["reader", "writer", "commenter"], description: "Share role (default: reader)" },
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

    const action = input.action as string;
    const drive = google.drive({ version: "v3", auth });

    try {
      switch (action) {
        case "list": {
          const maxResults = Math.min(50, Math.max(1, Number(input.max_results) || 10));
          let q = (input.query as string) || "";
          const folderId = input.folder_id as string;
          if (folderId) {
            q = q ? `${q} and '${folderId}' in parents` : `'${folderId}' in parents`;
          }
          if (!q) q = "trashed = false";
          else q += " and trashed = false";

          const res = await drive.files.list({
            q,
            pageSize: maxResults,
            fields: "files(id, name, mimeType, size, modifiedTime, webViewLink, parents)",
            orderBy: "modifiedTime desc",
          });

          const files = (res.data.files || []).map((f) => ({
            id: f.id,
            name: f.name,
            type: f.mimeType,
            size: f.size ? `${Math.round(Number(f.size) / 1024)}KB` : null,
            modified: f.modifiedTime,
            link: f.webViewLink,
          }));

          return JSON.stringify({ files, total: files.length });
        }

        case "upload": {
          const fileName = input.file_name as string;
          const content = input.content as string;
          if (!fileName || !content) return JSON.stringify({ error: "file_name and content are required" });

          const mimeType = (input.mime_type as string) || "text/plain";
          const folderId = input.folder_id as string;
          const metadata: any = { name: fileName };
          if (folderId) metadata.parents = [folderId];

          const stream = Readable.from([content]);
          const res = await drive.files.create({
            requestBody: metadata,
            media: { mimeType, body: stream },
            fields: "id, name, webViewLink",
          });

          return JSON.stringify({ success: true, id: res.data.id, name: res.data.name, link: res.data.webViewLink });
        }

        case "download": {
          const fileId = input.file_id as string;
          if (!fileId) return JSON.stringify({ error: "file_id is required" });

          // Get file metadata first
          const meta = await drive.files.get({ fileId, fields: "name, mimeType, size" });
          const mimeType = meta.data.mimeType || "";

          // Google Docs/Sheets/Slides → export as text
          if (mimeType.startsWith("application/vnd.google-apps.")) {
            let exportMime = "text/plain";
            if (mimeType.includes("spreadsheet")) exportMime = "text/csv";
            else if (mimeType.includes("presentation")) exportMime = "text/plain";

            const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: "text" });
            const text = String(res.data);
            return JSON.stringify({
              name: meta.data.name,
              type: mimeType,
              content: text.length > MAX_DOWNLOAD_SIZE ? text.substring(0, MAX_DOWNLOAD_SIZE) + "..." : text,
            });
          }

          // Regular file → download as text
          const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
          const text = String(res.data);
          return JSON.stringify({
            name: meta.data.name,
            type: mimeType,
            content: text.length > MAX_DOWNLOAD_SIZE ? text.substring(0, MAX_DOWNLOAD_SIZE) + "..." : text,
          });
        }

        case "create_folder": {
          const name = input.file_name as string;
          if (!name) return JSON.stringify({ error: "file_name is required" });
          const parentId = input.folder_id as string;
          const metadata: any = { name, mimeType: "application/vnd.google-apps.folder" };
          if (parentId) metadata.parents = [parentId];

          const res = await drive.files.create({ requestBody: metadata, fields: "id, name, webViewLink" });
          return JSON.stringify({ success: true, id: res.data.id, name: res.data.name, link: res.data.webViewLink });
        }

        case "share": {
          const fileId = input.file_id as string;
          const email = input.email as string;
          if (!fileId || !email) return JSON.stringify({ error: "file_id and email are required" });

          const role = (input.role as string) || "reader";
          await drive.permissions.create({
            fileId,
            requestBody: { type: "user", role, emailAddress: email },
          });
          return JSON.stringify({ success: true, shared: email, role });
        }

        case "delete": {
          const fileId = input.file_id as string;
          if (!fileId) return JSON.stringify({ error: "file_id is required" });
          await drive.files.delete({ fileId });
          return JSON.stringify({ success: true, deleted: fileId });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    } catch (err: any) {
      return JSON.stringify({ error: err?.message || String(err) });
    }
  },
};
