/**
 * sheets tool — Read/write Google Sheets
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { google } from "googleapis";
import { getUserGoogleAuth } from "./google-auth.js";

export const sheetsTool: ToolDefinition = {
  name: "sheets",
  description: `Read and write Google Sheets: read range, write data, append rows, create new spreadsheet, list sheets.
Actions: read, write, append, create, list_sheets.
Requires Google OAuth2 configured.`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["read", "write", "append", "create", "list_sheets"], description: "Action" },
      spreadsheet_id: { type: "string", description: "Spreadsheet ID (from URL)" },
      range: { type: "string", description: "Cell range e.g. 'Sheet1!A1:D10' (for read/write/append)" },
      values: {
        type: "array",
        description: "2D array of values to write e.g. [[\"Name\",\"Age\"],[\"John\",25]] (for write/append)",
        items: { type: "array", items: {} },
      },
      title: { type: "string", description: "Spreadsheet title (for create)" },
      sheet_names: {
        type: "array",
        description: "Sheet names to create (for create, default: ['Sheet1'])",
        items: { type: "string" },
      },
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
    const sheets = google.sheets({ version: "v4", auth });

    try {
      switch (action) {
        case "read": {
          const spreadsheetId = input.spreadsheet_id as string;
          const range = input.range as string;
          if (!spreadsheetId || !range) return JSON.stringify({ error: "spreadsheet_id and range are required" });

          const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
          const values = res.data.values || [];
          return JSON.stringify({
            range: res.data.range,
            rows: values.length,
            cols: values[0]?.length || 0,
            values,
          });
        }

        case "write": {
          const spreadsheetId = input.spreadsheet_id as string;
          const range = input.range as string;
          const values = input.values as any[][];
          if (!spreadsheetId || !range || !values) {
            return JSON.stringify({ error: "spreadsheet_id, range, values are required" });
          }

          const res = await sheets.spreadsheets.values.update({
            spreadsheetId,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
          });

          return JSON.stringify({
            success: true,
            updatedRange: res.data.updatedRange,
            updatedRows: res.data.updatedRows,
            updatedCells: res.data.updatedCells,
          });
        }

        case "append": {
          const spreadsheetId = input.spreadsheet_id as string;
          const range = input.range as string;
          const values = input.values as any[][];
          if (!spreadsheetId || !range || !values) {
            return JSON.stringify({ error: "spreadsheet_id, range, values are required" });
          }

          const res = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values },
          });

          return JSON.stringify({
            success: true,
            updatedRange: res.data.updates?.updatedRange,
            updatedRows: res.data.updates?.updatedRows,
          });
        }

        case "create": {
          const title = input.title as string;
          if (!title) return JSON.stringify({ error: "title is required" });

          const sheetNames = (input.sheet_names as string[]) || ["Sheet1"];
          const res = await sheets.spreadsheets.create({
            requestBody: {
              properties: { title },
              sheets: sheetNames.map((name) => ({ properties: { title: name } })),
            },
          });

          return JSON.stringify({
            success: true,
            id: res.data.spreadsheetId,
            title: res.data.properties?.title,
            url: res.data.spreadsheetUrl,
            sheets: res.data.sheets?.map((s) => s.properties?.title) || [],
          });
        }

        case "list_sheets": {
          const spreadsheetId = input.spreadsheet_id as string;
          if (!spreadsheetId) return JSON.stringify({ error: "spreadsheet_id is required" });

          const res = await sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties" });
          const sheetList = (res.data.sheets || []).map((s) => ({
            id: s.properties?.sheetId,
            title: s.properties?.title,
            rows: s.properties?.gridProperties?.rowCount,
            cols: s.properties?.gridProperties?.columnCount,
          }));

          return JSON.stringify({
            spreadsheet: res.data.properties?.title,
            sheets: sheetList,
            total: sheetList.length,
          });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    } catch (err: any) {
      return JSON.stringify({ error: err?.message || String(err) });
    }
  },
};
