import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  AgentResult,
  AgentTask,
  ProgressCallback,
  TaskStatus,
  TestAttempt,
} from "../types.js";
import {
  isTaskAbortedError,
  TaskAbortedError,
  throwIfAborted,
} from "../util/errors.js";
import { GitOrchestrator } from "./git.js";
import { runSelfHealingTests } from "./heal.js";
import { LlmClient } from "./llm.js";
import { detectTestCommand } from "./test-runner.js";
import { applyLlmTurn } from "./turn.js";

export interface AgentOptions {
  config: AppConfig;
  logger: Logger;
  onProgress?: ProgressCallback;
}

/**
 * Agent orchestration pipeline:
 *   fetch → worktree → LLM patch → self-healing tests → commit → push → cleanup
 *
 * Supports cancel via AbortController and hard wall-clock timeout.
 */
export class AgentPipeline {
  private readonly git: GitOrchestrator;
  private readonly llm: LlmClient;
  private readonly log: Logger;
  private readonly onProgress: ProgressCallback | undefined;
  private readonly active = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly opts: AgentOptions) {
    this.log = opts.logger.child({ component: "agent" });
    this.git = new GitOrchestrator(opts.config, this.log);
    this.llm = new LlmClient(opts.config, this.log);
    this.onProgress = opts.onProgress;
  }

  get activeTaskCount(): number {
    return this.active.size;
  }

  /** Returns true if a running task was signalled to abort. */
  cancel(taskId: string, reason = "cancelled by client"): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller || controller.signal.aborted) return false;
    this.log.info("cancel requested", { taskId, reason });
    controller.abort(new TaskAbortedError("cancelled", reason));
    return true;
  }

  async run(taskInput: AgentTask): Promise<AgentResult> {
    const task: AgentTask = {
      ...taskInput,
      id: taskInput.id || randomUUID(),
    };
    const startedAt = new Date();
    const startedMs = Date.now();
    const config = this.opts.config;
    const mainRepoPath = task.repoPath ?? config.MAIN_REPO_PATH;
    const baseBranch = task.baseBranch ?? config.DEFAULT_BASE_BRANCH;
    const token = task.githubToken ?? config.GITHUB_TOKEN;
    const remote = task.remote ?? "origin";
    const maxRetries = config.MAX_TEST_RETRIES;
    const testAttempts: TestAttempt[] = [];

    const { signal, clearTimeoutBudget } = this.beginTaskControl(task);
    this.active.add(task.id);
    this.emit(task.id, "running", "task accepted", {
      baseBranch,
      mainRepoPath,
    });

    let worktreePath = "";
    let branch = "";
    let commitSha: string | undefined;

    try {
      throwIfAborted(signal);

      const handle = await this.git.createWorktree({
        taskId: task.id,
        mainRepoPath,
        baseBranch,
        remote,
        signal,
        ...(token !== undefined ? { token } : {}),
      });
      worktreePath = handle.worktreePath;
      branch = handle.branch;
      this.emit(task.id, "running", "worktree ready", {
        worktreePath,
        branch,
      });
      throwIfAborted(signal);

      const detected = task.testCommand
        ? { command: task.testCommand, reason: "task override" }
        : await detectTestCommand(worktreePath);
      this.log.info("test command selected", {
        command: detected.command,
        reason: detected.reason,
      });

      await applyLlmTurn(this.llm, this.log, {
        task,
        worktreePath,
        attempt: 1,
        maxAttempts: maxRetries,
        signal,
      });
      throwIfAborted(signal);

      const green = await runSelfHealingTests(
        this.llm,
        this.log,
        (event) => this.onProgress?.(event),
        {
          task,
          worktreePath,
          testCommand: detected.command,
          maxRetries,
          testAttempts,
          signal,
        },
      );
      throwIfAborted(signal);

      if (!green) {
        const last = testAttempts[testAttempts.length - 1];
        throw new Error(
          `tests still failing after ${maxRetries} attempt(s)` +
            (last
              ? `\nlast exit ${last.result.exitCode}: ${last.result.stderr || last.result.stdout}`
              : ""),
        );
      }

      this.emit(task.id, "committing", "tests green; committing changes");
      commitSha = await this.git.commit(
        worktreePath,
        `aero-agent: ${task.id}\n\n${task.prompt.slice(0, 500)}`,
        signal,
      );
      this.emit(task.id, "pushing", "pushing branch to remote", {
        branch,
        commitSha,
      });
      await this.git.push({
        worktreePath,
        branch,
        remote,
        signal,
        ...(token !== undefined ? { token } : {}),
      });

      const result = this.finishResult({
        task,
        status: "succeeded",
        branch,
        worktreePath,
        ...(commitSha !== undefined ? { commitSha } : {}),
        pushRemote: remote,
        testAttempts,
        summary: `Branch ${branch} pushed at ${commitSha ?? "HEAD"}`,
        startedAt,
        startedMs,
      });
      this.emit(task.id, "succeeded", result.summary, {
        ...(commitSha !== undefined ? { commitSha } : {}),
        branch,
      });
      return result;
    } catch (err) {
      return this.finishError({
        err,
        task,
        branch,
        worktreePath,
        ...(commitSha !== undefined ? { commitSha } : {}),
        testAttempts,
        startedAt,
        startedMs,
      });
    } finally {
      clearTimeoutBudget();
      this.controllers.delete(task.id);
      if (worktreePath) {
        try {
          await this.git.removeWorktree(mainRepoPath, worktreePath);
          this.log.info("worktree cleaned", { worktreePath });
        } catch (cleanupErr) {
          this.log.warn("worktree cleanup failed", {
            worktreePath,
            error:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          });
        }
      }
      this.active.delete(task.id);
    }
  }

  private beginTaskControl(task: AgentTask): {
    signal: AbortSignal;
    clearTimeoutBudget: () => void;
  } {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const config = this.opts.config;

    const budgetMs =
      task.timeoutMs !== undefined
        ? task.timeoutMs
        : config.TASK_TIMEOUT_MS > 0
          ? config.TASK_TIMEOUT_MS
          : undefined;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (budgetMs !== undefined && budgetMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(
            new TaskAbortedError(
              "timeout",
              `task timed out after ${budgetMs}ms`,
            ),
          );
        }
      }, budgetMs);
      timeoutHandle.unref?.();
    }

    return {
      signal: controller.signal,
      clearTimeoutBudget: () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      },
    };
  }

  private finishResult(args: {
    task: AgentTask;
    status: Extract<TaskStatus, "succeeded">;
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
      status: args.status,
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

  private finishError(args: {
    err: unknown;
    task: AgentTask;
    branch: string;
    worktreePath: string;
    commitSha?: string;
    testAttempts: TestAttempt[];
    startedAt: Date;
    startedMs: number;
  }): AgentResult {
    const base = {
      taskId: args.task.id,
      branch: args.branch || `aero-agent/${args.task.id}`,
      worktreePath: args.worktreePath || "",
      ...(args.commitSha !== undefined ? { commitSha: args.commitSha } : {}),
      testAttempts: args.testAttempts,
      startedAt: args.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - args.startedMs,
    };

    if (isTaskAbortedError(args.err)) {
      this.log.warn("task aborted", {
        taskId: args.task.id,
        code: args.err.code,
        error: args.err.message,
      });
      this.emit(args.task.id, "cancelled", args.err.message, {
        code: args.err.code,
      });
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
    this.log.error("task failed", { taskId: args.task.id, error: message });
    this.emit(args.task.id, "failed", message);
    return {
      ...base,
      status: "failed",
      summary: "task failed",
      error: message,
    };
  }

  private emit(
    taskId: string,
    status: TaskStatus,
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    const event = {
      taskId,
      status,
      message,
      at: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {}),
    };
    this.log.info(message, { taskId, status, ...detail });
    this.onProgress?.(event);
  }
}
