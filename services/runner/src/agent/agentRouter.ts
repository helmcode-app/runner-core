import type {
  AgentRunAccepted,
  AgentRunParams,
  AgentTaskSnapshot,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
} from "../types.js";
import { branchNameForTask } from "./git.js";
import type { HelmCodeAgentEngine } from "./agentEngine.js";

/** JSON-RPC method names for the agent control plane. */
export const AgentMethod = {
  Run: "agent/run",
  Cancel: "agent/cancel",
  Status: "agent/status",
  List: "agent/list",
} as const;

export type AgentMethodName = (typeof AgentMethod)[keyof typeof AgentMethod];

export const AgentJsonRpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerError: -32000,
  Conflict: -32001,
  NotFound: -32002,
} as const;

export interface AgentRouterOptions {
  /**
   * When true (default), `agent/run` returns immediately with an accepted
   * envelope and executes the pipeline in the background. Progress is emitted
   * via the engine's onProgress callback (and optional `notify` hook).
   * When false, the JSON-RPC response awaits the full pipeline result.
   */
  asyncByDefault?: boolean;
}

export type AgentNotifyFn = (
  method: string,
  params: unknown,
) => void;

/**
 * Controller router for agent JSON-RPC methods.
 *
 * Handles `agent/run`, `agent/cancel`, `agent/status`, and `agent/list`.
 * Designed for the open-core WebSocket path used by the iPad client.
 */
export class AgentControllerRouter {
  private readonly asyncByDefault: boolean;

  constructor(
    private readonly engine: HelmCodeAgentEngine,
    private readonly opts: AgentRouterOptions = {},
  ) {
    this.asyncByDefault = opts.asyncByDefault !== false;
  }

  /**
   * Dispatch a single JSON-RPC request. Notifications (no id) are accepted
   * for fire-and-forget runs but still schedule work.
   */
  async handle(
    request: JsonRpcRequest,
    notify?: AgentNotifyFn,
  ): Promise<JsonRpcResponse | null> {
    if (!request || typeof request !== "object") {
      return errorResponse(null, AgentJsonRpcCode.InvalidRequest, "invalid request");
    }

    const id = request.id ?? null;
    const method = request.method;

    if (typeof method !== "string" || !method) {
      return errorResponse(id, AgentJsonRpcCode.InvalidRequest, "method is required");
    }

    try {
      switch (method) {
        case AgentMethod.Run:
          return await this.handleRun(id, request.params, notify);
        case AgentMethod.Cancel:
          return this.handleCancel(id, request.params);
        case AgentMethod.Status:
          return this.handleStatus(id, request.params);
        case AgentMethod.List:
          return this.handleList(id);
        default:
          return errorResponse(
            id,
            AgentJsonRpcCode.MethodNotFound,
            `method not found: ${method}`,
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Parameter / validation errors → InvalidParams
      if (
        /required|invalid|must be/i.test(message) &&
        !(err instanceof Error && err.name === "TaskAbortedError")
      ) {
        return errorResponse(id, AgentJsonRpcCode.InvalidParams, message);
      }
      return errorResponse(id, AgentJsonRpcCode.ServerError, message);
    }
  }

  private async handleRun(
    id: string | number | null,
    rawParams: unknown,
    notify?: AgentNotifyFn,
  ): Promise<JsonRpcResponse | null> {
    const params = parseAgentRunParams(rawParams);

    // Conflict if task id already has an active run.
    if (this.engine.isRunning(params.taskId)) {
      return errorResponse(
        id,
        AgentJsonRpcCode.Conflict,
        `task ${params.taskId} is already running`,
      );
    }

    const branch = branchNameForTask(params.taskId);

    if (this.asyncByDefault || id === null) {
      // Fire-and-forget orchestration; progress via notify + engine memory.
      const accepted: AgentRunAccepted = {
        taskId: params.taskId,
        status: "accepted",
        branch,
      };

      void this.engine
        .runFromParams(params)
        .then((result) => {
          notify?.("agent/done", {
            taskId: result.taskId,
            status: result.status === "succeeded" ? "success" : result.status,
            result,
          });
        })
        .catch((err: unknown) => {
          notify?.("agent/done", {
            taskId: params.taskId,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        });

      if (id === null) return null;
      return successResponse(id, accepted);
    }

    // Synchronous mode: await full pipeline.
    const result = await this.engine.runFromParams(params);
    return successResponse(id, {
      taskId: result.taskId,
      status: result.status === "succeeded" ? "success" : result.status,
      branch: result.branch,
      result,
    });
  }

  private handleCancel(
    id: string | number | null,
    rawParams: unknown,
  ): JsonRpcResponse | null {
    const taskId = extractTaskId(rawParams);
    const mem = this.engine.getMemory(taskId);
    if (!mem) {
      return errorResponse(
        id,
        AgentJsonRpcCode.NotFound,
        `task ${taskId} not found`,
      );
    }
    if (mem.result) {
      return errorResponse(
        id,
        AgentJsonRpcCode.Conflict,
        `task ${taskId} already finished (${mem.result.status})`,
      );
    }
    const ok = this.engine.cancel(taskId, "cancelled by client");
    if (!ok) {
      return errorResponse(
        id,
        AgentJsonRpcCode.Conflict,
        `task ${taskId} is not cancellable`,
      );
    }
    if (id === null) return null;
    return successResponse(id, {
      taskId,
      status: "cancelled",
      message: "cancel signal sent",
    });
  }

  private handleStatus(
    id: string | number | null,
    rawParams: unknown,
  ): JsonRpcResponse | null {
    if (id === null) return null;
    const taskId = extractTaskId(rawParams);
    const mem = this.engine.getMemory(taskId);
    if (!mem) {
      return errorResponse(
        id,
        AgentJsonRpcCode.NotFound,
        `task ${taskId} not found`,
      );
    }
    const snapshot: AgentTaskSnapshot = {
      taskId: mem.taskId,
      status: mem.result?.status ?? mem.liveStatus,
      branch: mem.branch,
      events: mem.events,
      result: mem.result ?? null,
      active: this.engine.isRunning(taskId),
    };
    return successResponse(id, snapshot);
  }

  private handleList(id: string | number | null): JsonRpcResponse | null {
    if (id === null) return null;
    const tasks = this.engine.listMemory().map((mem) => ({
      taskId: mem.taskId,
      status: mem.result?.status ?? mem.liveStatus,
      branch: mem.branch,
      eventCount: mem.events.length,
      active: this.engine.isRunning(mem.taskId),
      startedAt: mem.startedAt,
    }));
    return successResponse(id, {
      activeTasks: this.engine.activeTaskCount,
      tasks,
    });
  }
}

// ── param parsers ────────────────────────────────────────────────────────────

export function parseAgentRunParams(raw: unknown): AgentRunParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object");
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.prompt !== "string" || !p.prompt.trim()) {
    throw new Error("prompt is required");
  }

  const taskIdRaw = p.taskId ?? p.id;
  if (taskIdRaw !== undefined && typeof taskIdRaw !== "string") {
    throw new Error("taskId must be a string");
  }
  const taskId =
    typeof taskIdRaw === "string" && taskIdRaw.trim()
      ? taskIdRaw.trim()
      : cryptoRandomId();

  const out: AgentRunParams = {
    taskId,
    prompt: p.prompt,
  };

  if (p.baseBranch !== undefined) {
    if (typeof p.baseBranch !== "string") throw new Error("baseBranch must be a string");
    out.baseBranch = p.baseBranch;
  }
  if (p.testCommand !== undefined) {
    if (typeof p.testCommand !== "string") throw new Error("testCommand must be a string");
    out.testCommand = p.testCommand;
  }
  if (p.contextPaths !== undefined) {
    if (!Array.isArray(p.contextPaths) || !p.contextPaths.every((x) => typeof x === "string")) {
      throw new Error("contextPaths must be an array of strings");
    }
    out.contextPaths = p.contextPaths as string[];
  }
  if (p.githubToken !== undefined) {
    if (typeof p.githubToken !== "string") throw new Error("githubToken must be a string");
    out.githubToken = p.githubToken;
  }
  if (p.maxCycles !== undefined) {
    if (typeof p.maxCycles !== "number" || !Number.isInteger(p.maxCycles) || p.maxCycles < 1) {
      throw new Error("maxCycles must be a positive integer");
    }
    out.maxCycles = p.maxCycles;
  }
  if (p.repoPath !== undefined) {
    if (typeof p.repoPath !== "string") throw new Error("repoPath must be a string");
    out.repoPath = p.repoPath;
  }
  if (p.remote !== undefined) {
    if (typeof p.remote !== "string") throw new Error("remote must be a string");
    out.remote = p.remote;
  }
  if (p.timeoutMs !== undefined) {
    if (typeof p.timeoutMs !== "number" || p.timeoutMs < 0) {
      throw new Error("timeoutMs must be a non-negative number");
    }
    out.timeoutMs = p.timeoutMs;
  }
  if (p.metadata !== undefined) {
    if (!p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata)) {
      throw new Error("metadata must be an object");
    }
    out.metadata = p.metadata as Record<string, unknown>;
  }

  return out;
}

function extractTaskId(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with taskId");
  }
  const p = raw as Record<string, unknown>;
  const taskId = p.taskId ?? p.id;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("taskId is required");
  }
  return taskId.trim();
}

function successResponse<T>(
  id: string | number | null,
  result: T,
): JsonRpcSuccess<T> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}`;
}
