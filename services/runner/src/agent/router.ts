import type {
  AgentRunAccepted,
  AgentTaskSnapshot,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types.js";
import type { HelmCodeAgentEngine } from "./engine.js";
import { branchNameForTask } from "./git.js";
import { extractTaskId, parseAgentRunParams } from "./parse-run.js";
import {
  AgentJsonRpcCode,
  AgentMethod,
  errorResponse,
  successResponse,
} from "./protocol.js";

export {
  AgentMethod,
  AgentJsonRpcCode,
  type AgentMethodName,
  successResponse,
  errorResponse,
} from "./protocol.js";
export { parseAgentRunParams, extractTaskId } from "./parse-run.js";

export interface AgentRouterOptions {
  /**
   * When true (default), `agent/run` returns immediately with an accepted
   * envelope and executes the pipeline in the background.
   */
  asyncByDefault?: boolean;
}

export type AgentNotifyFn = (method: string, params: unknown) => void;

/**
 * Controller for agent JSON-RPC methods over WebSocket / tests.
 * Handles `agent/run`, `agent/cancel`, `agent/status`, `agent/list`.
 */
export class AgentControllerRouter {
  private readonly asyncByDefault: boolean;

  constructor(
    private readonly engine: HelmCodeAgentEngine,
    private readonly opts: AgentRouterOptions = {},
  ) {
    this.asyncByDefault = opts.asyncByDefault !== false;
  }

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

    if (this.engine.isRunning(params.taskId)) {
      return errorResponse(
        id,
        AgentJsonRpcCode.Conflict,
        `task ${params.taskId} is already running`,
      );
    }

    const branch = branchNameForTask(params.taskId);

    if (this.asyncByDefault || id === null) {
      const accepted: AgentRunAccepted = {
        taskId: params.taskId,
        status: "accepted",
        branch,
      };

      void this.engine
        .runFromParams(params)
        .then((result) => {
          notify?.(AgentMethod.Done, {
            taskId: result.taskId,
            status: result.status === "succeeded" ? "success" : result.status,
            result,
          });
        })
        .catch((err: unknown) => {
          notify?.(AgentMethod.Done, {
            taskId: params.taskId,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        });

      if (id === null) return null;
      return successResponse(id, accepted);
    }

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
