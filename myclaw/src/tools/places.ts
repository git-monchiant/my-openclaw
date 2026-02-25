/**
 * places tool — ค้นหาสถานที่ + ส่ง LINE location message
 *
 * Actions:
 * - search: ค้นหาสถานที่จาก Nominatim (OpenStreetMap) → ชื่อ, ที่อยู่, พิกัด
 * - send_location: ส่ง LINE location message ให้ user (เปิด Google Maps ได้)
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { trackLinePush } from "../admin/usage-tracker.js";

interface NominatimResult {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  type: string;
  address?: Record<string, string>;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export const placesTool: ToolDefinition = {
  name: "places",
  description:
    'Search for places and send location pins on LINE. Actions: ' +
    '"search" to find places by name/query (returns coordinates, address, map URL), ' +
    '"send_location" to send a LINE location message pin that the user can tap to open Google Maps. ' +
    "Workflow: 1) search for the place, 2) describe it to the user, 3) ask if they want a map pin, 4) send_location if yes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["search", "send_location"],
        description: "Action to perform.",
      },
      query: {
        type: "string",
        description: 'Place name or search query (for "search"). E.g. "Central World Bangkok", "ร้านส้มตำ ซอยอารีย์".',
      },
      name: {
        type: "string",
        description: 'Place name to display (for "send_location").',
      },
      address: {
        type: "string",
        description: 'Address text (for "send_location").',
      },
      latitude: {
        type: "number",
        description: 'Latitude (for "send_location").',
      },
      longitude: {
        type: "number",
        description: 'Longitude (for "send_location").',
      },
      userId: {
        type: "string",
        description: "Target user ID. Defaults to current user.",
      },
    },
    required: ["action"],
  },

  execute: async (
    input: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<string> => {
    const action = input.action as string;

    switch (action) {
      case "search": {
        const query = input.query as string;
        if (!query) return JSON.stringify({ error: "query is required for search" });

        try {
          const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1&accept-language=th,en`;
          const res = await fetch(url, {
            headers: { "User-Agent": "MyClaw-LINE-Bot/1.0" },
            signal: AbortSignal.timeout(10_000),
          });

          if (!res.ok) {
            return JSON.stringify({ error: `Nominatim API error: ${res.status}` });
          }

          const results = (await res.json()) as NominatimResult[];
          if (results.length === 0) {
            return JSON.stringify({ results: [], message: "ไม่พบสถานที่ที่ค้นหา" });
          }

          const places = results.map((r) => ({
            name: r.name || r.display_name.split(",")[0],
            address: r.display_name,
            latitude: parseFloat(r.lat),
            longitude: parseFloat(r.lon),
            type: r.type,
            mapUrl: `https://www.google.com/maps?q=${r.lat},${r.lon}`,
          }));

          console.log(`[places] search "${query}" → ${places.length} results`);
          return JSON.stringify({ results: places });
        } catch (err: any) {
          console.error("[places] search error:", err);
          return JSON.stringify({ error: err?.message || "search failed" });
        }
      }

      case "send_location": {
        const name = (input.name as string) || "สถานที่";
        const address = (input.address as string) || "";
        const lat = input.latitude as number;
        const lon = input.longitude as number;

        if (lat == null || lon == null) {
          return JSON.stringify({ error: "latitude and longitude are required" });
        }

        const targetUserId = (input.userId as string) || context?.userId;
        if (!targetUserId) return JSON.stringify({ error: "no userId" });

        const lineClient = context?.lineClient;
        if (!lineClient) return JSON.stringify({ error: "LINE client not available" });

        try {
          trackLinePush(targetUserId, "places");
          await lineClient.pushMessage({
            to: targetUserId,
            messages: [{
              type: "location",
              title: name.substring(0, 100),
              address: (address || `${lat}, ${lon}`).substring(0, 100),
              latitude: lat,
              longitude: lon,
            }],
          });

          console.log(`[places] sent location "${name}" to ${targetUserId}`);
          return JSON.stringify({
            success: true,
            message: `ส่ง location "${name}" ให้ user แล้ว`,
            mapUrl: `https://www.google.com/maps?q=${lat},${lon}`,
          });
        } catch (err: any) {
          console.error("[places] send_location error:", err);
          return JSON.stringify({ error: err?.message || "send failed" });
        }
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  },
};
