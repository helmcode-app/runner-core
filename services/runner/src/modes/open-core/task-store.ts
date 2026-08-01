import { randomUUID } from "node:crypto";
import type { AgentPipeline } from "../../agent/index.js";
import type {
  AgentResult,
  AgentTask,
  OpenCoreSubmitBody,
  TaskProgressEvent,
  TaskStatus,
} from "../../types.js";

export interface TaskRecord {
  result?: AgentResult;
  events: TaskProgressEvent[];
  promise: Promise<AgentResult>;
  /** Latest non-terminal status while in flight. */
  liveStatus: TaskStatus;
}

/** In-memory task registry for open-core polling clients. */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  get size(): number {
    return this.tasks.size;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /** Wire agent progress into the matching task record. */
  onProgress(event: TaskProgressEvent): void {
    const rec = this.tasks.get(event.taskId);
    if (!rec) return;
    rec.events.push(event);
    if (
      event.status !== "succeeded" &&
      event.status !== "failed" &&
      event.status !== "cancelled"
    ) {
      rec.liveStatus = event.status;
    }
  }

  /**
   * Accept an async task: returns 202 payload fields or a conflict error.
   */
  submitAsync(
    agent: AgentPipeline,
    body: OpenCoreSubmitBody,
  ):
    | { ok: true; id: string; poll: string; cancel: string }
    | { ok: false; status: 400 | 409; error: string } {
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return { ok: false, status: 400, error: "prompt is required" };
    }

    const id = body.id?.trim() || randomUUID();
    if (this.tasks.has(id)) {
      return { ok: false, status: 409, error: `task ${id} already exists` };
    }

    const record: TaskRecord = {
      events: [],
      promise: Promise.resolve({} as AgentResult),
      liveStatus: "queued",
    };
    this.tasks.set(id, record);

    record.promise = agent
      .run(toAgentTask(id, body))
      .then((result) => {
        record.result = result;
        record.liveStatus = result.status;
        return result;
      });
    void record.promise.catch(() => undefined);

    return {
      ok: true,
      id,
      poll: `/v1/tasks/${id}`,
      cancel: `/v1/tasks/${id}/cancel`,
    };
  }

  async submitSync(
    agent: AgentPipeline,
    body: OpenCoreSubmitBody,
  ): Promise<
    | { ok: true; result: AgentResult }
    | { ok: false; status: 400; error: string }
  > {
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return { ok: false, status: 400, error: "prompt is required" };
    }
    const id = body.id?.trim() || randomUUID();
    const result = await agent.run(toAgentTask(id, body));
    return { ok: true, result };
  }

  cancel(
    agent: AgentPipeline,
    id: string,
  ):
    | { ok: true }
    | { ok: false; status: 404 | 409; error: string; taskStatus?: string } {
    const rec = this.tasks.get(id);
    if (!rec) {
      return { ok: false, status: 404, error: "task not found" };
    }
    if (rec.result) {
      return {
        ok: false,
        status: 409,
        error: "task already finished",
        taskStatus: rec.result.status,
      };
    }
    if (!agent.cancel(id, "cancelled by client")) {
      return { ok: false, status: 409, error: "task is not cancellable" };
    }
    rec.liveStatus = "cancelled";
    return { ok: true };
  }
}

export function toAgentTask(id: string, body: OpenCoreSubmitBody): AgentTask {
  return {
    id,
    prompt: body.prompt,
    ...(body.baseBranch !== undefined ? { baseBranch: body.baseBranch } : {}),
    ...(body.testCommand !== undefined ? { testCommand: body.testCommand } : {}),
    ...(body.contextPaths !== undefined
      ? { contextPaths: body.contextPaths }
      : {}),
    ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
  };
}

export function httpStatusForResult(
  status: AgentResult["status"],
): 200 | 409 | 422 {
  if (status === "succeeded") return 200;
  if (status === "cancelled") return 409;
  return 422;
}
