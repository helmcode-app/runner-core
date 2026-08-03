import type { Logger } from "../logger.js";
import type {
  AgentResult,
  ProgressCallback,
  TaskProgressEvent,
  TaskStatus,
} from "../types.js";

/** Live per-task memory (timeline + status) held by the engine. */
export interface AgentMemory {
  taskId: string;
  events: TaskProgressEvent[];
  liveStatus: TaskStatus;
  result?: AgentResult;
  branch: string;
  startedAt: string;
}

export function createAgentMemory(
  taskId: string,
  branch: string,
  startedAt: string,
): AgentMemory {
  return {
    taskId,
    events: [],
    liveStatus: "queued",
    branch,
    startedAt,
  };
}

/**
 * Append a timeline event, update live status, log, and fan out progress.
 */
export function pushAgentEvent(
  mem: AgentMemory,
  event: TaskProgressEvent,
  log: Logger,
  onProgress?: ProgressCallback,
): void {
  mem.events.push(event);
  if (
    event.status !== "succeeded" &&
    event.status !== "failed" &&
    event.status !== "cancelled"
  ) {
    mem.liveStatus = event.status;
  }
  log.info(event.message, {
    taskId: event.taskId,
    status: event.status,
    stage: event.stage,
    cycle: event.cycle,
    ...event.detail,
  });
  onProgress?.(event);
}
