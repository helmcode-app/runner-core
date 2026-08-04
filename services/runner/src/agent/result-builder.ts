import type { Logger } from "../logger.js";
import type {
  AgentResult,
  AgentTask,
  ProgressCallback,
  TestAttempt,
} from "../types.js";
import { isTaskAbortedError } from "../util/errors.js";
import type { AgentMemory } from "./events.js";
import { pushAgentEvent } from "./events.js";
import { branchNameForTask } from "./git.js";

export function buildSuccessResult(args: {
  task: AgentTask;
  branch: string;
  worktreePath: string;
  commitSha?: string;
  pushRemote: string;
  testAttempts: TestAttempt[];
  summary: string;
  startedAt: Date;
  startedMs: number;
}): AgentResult {
  return {
    taskId: args.task.id,
    status: "succeeded",
    branch: args.branch,
    worktreePath: args.worktreePath,
    ...(args.commitSha !== undefined ? { commitSha: args.commitSha } : {}),
    pushRemote: args.pushRemote,
    testAttempts: args.testAttempts,
    summary: args.summary,
    startedAt: args.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - args.startedMs,
  };
}

export function buildErrorResult(args: {
  err: unknown;
  task: AgentTask;
  branch: string;
  worktreePath: string;
  commitSha?: string;
  testAttempts: TestAttempt[];
  startedAt: Date;
  startedMs: number;
  mem: AgentMemory;
  log: Logger;
  onProgress?: ProgressCallback;
}): AgentResult {
  const base = {
    taskId: args.task.id,
    branch: args.branch || branchNameForTask(args.task.id),
    worktreePath: args.worktreePath || "",
    ...(args.commitSha !== undefined ? { commitSha: args.commitSha } : {}),
    testAttempts: args.testAttempts,
    startedAt: args.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - args.startedMs,
  };

  if (isTaskAbortedError(args.err)) {
    args.log.warn("task aborted", {
      taskId: args.task.id,
      code: args.err.code,
      error: args.err.message,
    });
    pushAgentEvent(
      args.mem,
      {
        taskId: args.task.id,
        status: "cancelled",
        stage: "cancelled",
        message: args.err.message,
        at: new Date().toISOString(),
        detail: { code: args.err.code },
      },
      args.log,
      args.onProgress,
    );
    return {
      ...base,
      status: "cancelled",
      summary:
        args.err.code === "timeout" ? "task timed out" : "task cancelled",
      error: args.err.message,
    };
  }

  const message =
    args.err instanceof Error ? args.err.message : String(args.err);
  args.log.error("task failed", { taskId: args.task.id, error: message });
  pushAgentEvent(
    args.mem,
    {
      taskId: args.task.id,
      status: "failed",
      stage: "failed",
      message,
      at: new Date().toISOString(),
    },
    args.log,
    args.onProgress,
  );
  return {
    ...base,
    status: "failed",
    summary: "task failed",
    error: message,
  };
}
