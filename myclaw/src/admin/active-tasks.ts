/**
 * Active Task Tracker + Execution Traces
 *
 * 1. Real-time tracking: ดู agent ไหนกำลังทำอะไร (in-memory)
 * 2. Execution traces: บันทึกทุก step ของแต่ละ message → ดูย้อนหลังใน admin
 *
 * ใช้ SSE emit ให้ dashboard update แบบ real-time
 */

import { emitDashboardEvent } from "./events.js";

// ===== Execution Trace =====

export interface TraceStep {
  ts: number;
  type: "receive" | "thinking" | "delegate" | "tool_call" | "result" | "error" | "respond";
  agent?: string;       // agent ที่เกี่ยวข้อง
  tool?: string;        // tool ที่เรียก
  detail?: string;      // รายละเอียด (task description, tool args, etc.)
  result?: string;      // ผลลัพธ์ (truncated)
  elapsed?: number;     // ms ที่ใช้ใน step นี้
}

export interface ExecutionTrace {
  id: string;           // unique trace ID
  userId: string;
  message: string;      // user's original message (truncated)
  startedAt: number;
  completedAt?: number;
  totalElapsed?: number;
  steps: TraceStep[];
  status: "running" | "completed" | "error";
}

// ===== Active Task (real-time) =====

export interface ActiveTask {
  userId: string;
  agent: string;       // "orchestrator" | agent ID
  step: string;        // "thinking" | "delegating" | "tool_call" | "responding"
  tool?: string;
  detail?: string;
  startedAt: number;
  taskStartedAt: number;
  traceId: string;     // link to execution trace
}

// ===== Storage =====

const activeTasks = new Map<string, ActiveTask>();
const activeTraces = new Map<string, ExecutionTrace>();  // running traces (by traceId)

const MAX_COMPLETED_TRACES = 100;
const completedTraces: ExecutionTrace[] = [];  // ring buffer of recent completed traces

let traceCounter = 0;
function genTraceId(): string {
  return `tr_${Date.now().toString(36)}_${(++traceCounter).toString(36)}`;
}

// ===== Task tracking (existing API, extended with traces) =====

/** Start tracking a new task + begin execution trace */
export function startTask(userId: string, agent: string, detail?: string): string {
  // ถ้ามี task เก่าค้างอยู่ (เช่น follow-up หลัง media) → ปิด trace เก่าก่อน
  const prev = activeTasks.get(userId);
  if (prev) {
    const oldTrace = activeTraces.get(prev.traceId);
    if (oldTrace) {
      oldTrace.completedAt = Date.now();
      oldTrace.totalElapsed = Date.now() - prev.taskStartedAt;
      oldTrace.status = "completed";
      activeTraces.delete(prev.traceId);
      completedTraces.unshift(oldTrace);
      if (completedTraces.length > MAX_COMPLETED_TRACES) completedTraces.pop();
    }
    activeTasks.delete(userId);
  }

  const now = Date.now();
  const traceId = genTraceId();

  // Create execution trace
  const trace: ExecutionTrace = {
    id: traceId,
    userId,
    message: detail || "",
    startedAt: now,
    steps: [
      { ts: now, type: "receive", detail: detail?.substring(0, 200) },
      { ts: now, type: "thinking", agent },
    ],
    status: "running",
  };
  activeTraces.set(traceId, trace);

  // Create active task
  activeTasks.set(userId, {
    userId,
    agent,
    step: "thinking",
    detail,
    startedAt: now,
    taskStartedAt: now,
    traceId,
  });

  emitDashboardEvent("agent_activity", {
    userId: userId.substring(0, 8),
    action: "start",
    agent,
    step: "thinking",
    detail,
    traceId,
  });

  return traceId;
}

/** Update the current step + record trace step */
export function updateTask(userId: string, update: Partial<Pick<ActiveTask, "agent" | "step" | "tool" | "detail">>): void {
  const existing = activeTasks.get(userId);
  if (!existing) return;

  const now = Date.now();
  const stepElapsed = now - existing.startedAt;

  // Record step in trace
  const trace = activeTraces.get(existing.traceId);
  if (trace) {
    // Map task step to trace step type
    let traceType: TraceStep["type"] = "thinking";
    if (update.step === "delegating" || update.tool === "delegate_task") traceType = "delegate";
    else if (update.step === "tool_call") traceType = "tool_call";
    else if (update.step === "responding") traceType = "respond";

    trace.steps.push({
      ts: now,
      type: traceType,
      agent: update.agent || existing.agent,
      tool: update.tool,
      detail: update.detail?.substring(0, 300),
      elapsed: stepElapsed,
    });
  }

  Object.assign(existing, update, { startedAt: now });

  emitDashboardEvent("agent_activity", {
    userId: userId.substring(0, 8),
    action: "update",
    agent: existing.agent,
    step: existing.step,
    tool: existing.tool,
    detail: existing.detail,
    traceId: existing.traceId,
  });
}

/** Record a delegation result in the trace */
export function recordTraceResult(userId: string, agent: string, result: string, elapsed?: number): void {
  const existing = activeTasks.get(userId);
  if (!existing) return;

  const trace = activeTraces.get(existing.traceId);
  if (trace) {
    trace.steps.push({
      ts: Date.now(),
      type: "result",
      agent,
      result: result.substring(0, 2000),
      elapsed,
    });
  }
}

/** Record an error in the trace */
export function recordTraceError(userId: string, agent: string, error: string): void {
  const existing = activeTasks.get(userId);
  if (!existing) return;

  const trace = activeTraces.get(existing.traceId);
  if (trace) {
    trace.steps.push({
      ts: Date.now(),
      type: "error",
      agent,
      detail: error.substring(0, 500),
    });
  }
}

/** Clear tracking when task completes — move trace to completed buffer */
export function endTask(userId: string, finalResponse?: string): void {
  const existing = activeTasks.get(userId);
  if (!existing) return;

  const now = Date.now();
  const elapsed = now - existing.taskStartedAt;

  // Finalize trace
  const trace = activeTraces.get(existing.traceId);
  if (trace) {
    if (finalResponse) {
      trace.steps.push({
        ts: now,
        type: "respond",
        detail: finalResponse.substring(0, 2000),
      });
    }
    trace.completedAt = now;
    trace.totalElapsed = elapsed;
    trace.status = "completed";
    activeTraces.delete(existing.traceId);

    // Add to completed buffer (ring)
    completedTraces.unshift(trace);
    if (completedTraces.length > MAX_COMPLETED_TRACES) {
      completedTraces.pop();
    }
  }

  activeTasks.delete(userId);

  emitDashboardEvent("agent_activity", {
    userId: userId.substring(0, 8),
    action: "end",
    agent: existing.agent,
    elapsed,
    traceId: existing.traceId,
  });
}

// ===== Query APIs =====

/** Get all currently active tasks */
export function getActiveTasks(): (ActiveTask & { stepElapsedMs: number; totalElapsedMs: number })[] {
  const now = Date.now();
  return [...activeTasks.values()].map((t) => ({
    ...t,
    stepElapsedMs: now - t.startedAt,
    totalElapsedMs: now - t.taskStartedAt,
  }));
}

/** Get recent execution traces (completed + running) */
export function getTraces(limit = 50): ExecutionTrace[] {
  const running = [...activeTraces.values()];
  const recent = completedTraces.slice(0, limit - running.length);
  return [...running, ...recent];
}

/** Get a single trace by ID */
export function getTrace(traceId: string): ExecutionTrace | undefined {
  return activeTraces.get(traceId) || completedTraces.find((t) => t.id === traceId);
}
