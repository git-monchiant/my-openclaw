/**
 * calendar tool — Manage Google Calendar events
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { google } from "googleapis";
import { getUserGoogleAuth } from "./google-auth.js";
import { getDefaultCalendar, setDefaultCalendar } from "../google/store.js";

export const calendarTool: ToolDefinition = {
  name: "calendar",
  description: `Manage Google Calendar: list calendars, list events, create, update, delete, check free/busy, set default calendar.
Actions: calendars, list, create, update, delete, freebusy, set_default.
Use "calendars" first to discover available calendars, then use calendar_id to target a specific one.
Use "set_default" with calendar_id to change which calendar is used by default.
Requires Google OAuth2 configured.`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["calendars", "list", "create", "update", "delete", "freebusy", "set_default"], description: "Action" },
      calendar_id: { type: "string", description: "Calendar ID (default: primary)" },
      // list
      time_min: { type: "string", description: "Start date/time ISO (for list, default: now)" },
      time_max: { type: "string", description: "End date/time ISO (for list, default: +7 days)" },
      max_results: { type: "number", description: "Max events (default: 10, max: 50)" },
      // create/update
      event_id: { type: "string", description: "Event ID (for update/delete)" },
      title: { type: "string", description: "Event title (for create/update)" },
      start: { type: "string", description: "Start date/time ISO (for create/update)" },
      end: { type: "string", description: "End date/time ISO (for create/update)" },
      location: { type: "string", description: "Location (for create/update)" },
      description: { type: "string", description: "Description (for create/update)" },
      all_day: { type: "boolean", description: "All-day event (use date format YYYY-MM-DD)" },
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
    const dataDir = process.env.DATA_DIR || "./data";
    const userDefault = getDefaultCalendar(dataDir, context?.userId || "");
    const calId = (input.calendar_id as string) || userDefault || "primary";
    const cal = google.calendar({ version: "v3", auth });

    try {
      switch (action) {
        case "calendars": {
          const res = await cal.calendarList.list();
          const calendars = (res.data.items || []).map((c) => ({
            id: c.id,
            name: c.summary,
            description: c.description || null,
            primary: c.primary || false,
            accessRole: c.accessRole,
            color: c.backgroundColor,
          }));
          return JSON.stringify({ calendars, total: calendars.length });
        }

        case "list": {
          const now = new Date();
          const weekLater = new Date(now.getTime() + 7 * 86400000);
          const timeMin = (input.time_min as string) || now.toISOString();
          const timeMax = (input.time_max as string) || weekLater.toISOString();
          const maxResults = Math.min(50, Math.max(1, Number(input.max_results) || 10));

          const res = await cal.events.list({
            calendarId: calId,
            timeMin,
            timeMax,
            maxResults,
            singleEvents: true,
            orderBy: "startTime",
          });

          const events = (res.data.items || []).map((e) => ({
            id: e.id,
            title: e.summary,
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date,
            location: e.location || null,
            description: e.description ? (e.description.length > 200 ? e.description.substring(0, 200) + "..." : e.description) : null,
            status: e.status,
            htmlLink: e.htmlLink,
          }));

          return JSON.stringify({ events, total: events.length, range: { from: timeMin, to: timeMax } });
        }

        case "create": {
          const title = input.title as string;
          const start = input.start as string;
          const end = input.end as string;
          if (!title || !start || !end) return JSON.stringify({ error: "title, start, end are required" });

          const isAllDay = input.all_day === true;
          const event: any = {
            summary: title,
            start: isAllDay ? { date: start } : { dateTime: start, timeZone: "Asia/Bangkok" },
            end: isAllDay ? { date: end } : { dateTime: end, timeZone: "Asia/Bangkok" },
          };
          if (input.location) event.location = input.location;
          if (input.description) event.description = input.description;

          const res = await cal.events.insert({ calendarId: calId, requestBody: event });
          return JSON.stringify({
            success: true,
            id: res.data.id,
            title: res.data.summary,
            start: res.data.start?.dateTime || res.data.start?.date,
            htmlLink: res.data.htmlLink,
          });
        }

        case "update": {
          const eventId = input.event_id as string;
          if (!eventId) return JSON.stringify({ error: "event_id is required" });

          const patch: any = {};
          if (input.title) patch.summary = input.title;
          if (input.location) patch.location = input.location;
          if (input.description) patch.description = input.description;
          if (input.start) {
            patch.start = input.all_day ? { date: input.start } : { dateTime: input.start, timeZone: "Asia/Bangkok" };
          }
          if (input.end) {
            patch.end = input.all_day ? { date: input.end } : { dateTime: input.end, timeZone: "Asia/Bangkok" };
          }

          const res = await cal.events.patch({ calendarId: calId, eventId, requestBody: patch });
          return JSON.stringify({ success: true, id: res.data.id, title: res.data.summary });
        }

        case "delete": {
          const eventId = input.event_id as string;
          if (!eventId) return JSON.stringify({ error: "event_id is required" });
          await cal.events.delete({ calendarId: calId, eventId });
          return JSON.stringify({ success: true, deleted: eventId });
        }

        case "freebusy": {
          const now = new Date();
          const dayLater = new Date(now.getTime() + 86400000);
          const timeMin = (input.time_min as string) || now.toISOString();
          const timeMax = (input.time_max as string) || dayLater.toISOString();

          const res = await cal.freebusy.query({
            requestBody: {
              timeMin,
              timeMax,
              items: [{ id: calId }],
            },
          });

          const busy = res.data.calendars?.[calId]?.busy || [];
          return JSON.stringify({ busy, free: busy.length === 0, range: { from: timeMin, to: timeMax } });
        }

        case "set_default": {
          const newDefault = input.calendar_id as string;
          if (!newDefault) return JSON.stringify({ error: "calendar_id is required" });
          setDefaultCalendar(dataDir, context?.userId || "", newDefault);
          return JSON.stringify({ success: true, default_calendar_id: newDefault });
        }

        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    } catch (err: any) {
      return JSON.stringify({ error: err?.message || String(err) });
    }
  },
};
