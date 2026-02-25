/**
 * user_profile tool — Get/set user preferences and personal info
 * AI uses this to remember what the user tells about themselves
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import {
  getUserProfile,
  getProfileField,
  setProfileField,
  deleteProfileField,
} from "../profile/store.js";

export const userProfileTool: ToolDefinition = {
  name: "user_profile",
  description: `Get or update the user's profile (name, nickname, timezone, preferences, notes).
Use this to remember personal information the user shares.
Actions: get (read profile or a single field), set (save a field), delete (remove a field).`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["get", "set", "delete"],
        description: "Action to perform",
      },
      key: {
        type: "string",
        description:
          "Profile field name (e.g. 'name', 'nickname', 'timezone', 'notes', or any custom key like 'favorite_food'). Required for set/delete. Optional for get (omit to get all).",
      },
      value: {
        type: "string",
        description: "Value to save. Required for 'set' action.",
      },
    },
    required: ["action"],
  },

  async execute(input, context?: ToolContext) {
    const userId = context?.userId;
    if (!userId) {
      return JSON.stringify({ error: "Cannot determine user" });
    }

    const dataDir = process.env.DATA_DIR || "./data";
    const action = input.action as string;
    const key = (input.key as string)?.toLowerCase().trim();
    const value = (input.value as string)?.trim();

    switch (action) {
      case "get": {
        if (key) {
          const val = getProfileField(dataDir, userId, key);
          if (val === null) {
            return JSON.stringify({ action: "get", key, value: null, message: `No profile field "${key}" found` });
          }
          return JSON.stringify({ action: "get", key, value: val });
        }
        // Get all fields
        const profile = getUserProfile(dataDir, userId);
        const count = Object.keys(profile).length;
        if (count === 0) {
          return JSON.stringify({ action: "get", fields: {}, fieldCount: 0, message: "No profile data yet" });
        }
        return JSON.stringify({ action: "get", fields: profile, fieldCount: count });
      }

      case "set": {
        if (!key) return JSON.stringify({ error: "key is required for set" });
        if (!value) return JSON.stringify({ error: "value is required for set" });
        setProfileField(dataDir, userId, key, value);
        return JSON.stringify({ success: true, action: "set", key, value });
      }

      case "delete": {
        if (!key) return JSON.stringify({ error: "key is required for delete" });
        const deleted = deleteProfileField(dataDir, userId, key);
        if (!deleted) {
          return JSON.stringify({ action: "delete", key, message: `Field "${key}" not found` });
        }
        return JSON.stringify({ success: true, action: "delete", key });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
};
