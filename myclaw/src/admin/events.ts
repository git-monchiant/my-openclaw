/**
 * SSE Event Bus — Real-time dashboard updates
 *
 * Central event emitter: tracking functions → bus → SSE clients
 * ใช้ Node.js EventEmitter (built-in, ไม่ต้อง install)
 */

import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

// ===== Event types =====
export type DashboardEventType =
  | "gemini_call"
  | "line_push"
  | "webhook"
  | "log"
  | "queue_change"
  | "cron_run"
  | "agent_activity";

export interface DashboardEvent {
  type: DashboardEventType;
  ts: number;
  data: Record<string, unknown>;
}

// ===== Singleton event bus =====
const bus = new EventEmitter();
bus.setMaxListeners(50); // Support multiple SSE clients

// Track connected clients
interface SSEClient {
  id: string;
  res: Response;
  connectedAt: number;
}

const clients = new Set<SSEClient>();

/** Publish event to all connected SSE clients */
export function emitDashboardEvent(type: DashboardEventType, data: Record<string, unknown>): void {
  bus.emit("dashboard", { type, ts: Date.now(), data });
}

/** Get count of connected SSE clients */
export function getSSEClientCount(): number {
  return clients.size;
}

/** Express handler: GET /api/events — SSE stream */
export function sseHandler(req: Request, res: Response): void {
  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx/reverse-proxy buffering
  });

  const clientId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const client: SSEClient = { id: clientId, res, connectedAt: Date.now() };
  clients.add(client);

  console.log(`[SSE] Client connected: ${clientId} (${clients.size} total)`);

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, ts: Date.now() })}\n\n`);

  // Heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      // Client disconnected — cleanup will happen in "close" handler
    }
  }, 15_000);

  // Forward dashboard events to this client
  const handler = (event: DashboardEvent) => {
    try {
      res.write(`id: ${event.ts}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };
  bus.on("dashboard", handler);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off("dashboard", handler);
    clients.delete(client);
    console.log(`[SSE] Client disconnected: ${clientId} (${clients.size} remaining)`);
  });
}
