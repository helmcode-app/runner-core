import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  AgentResult,
  AgentTask,
  ProgressCallback,
  TestAttempt,
} from "../types.js";
import {
  isTaskAbortedError,
  TaskAbortedError,
  throwIfAborted,
} from "../util/errors.js";
import { listFiles } from "../util/fs.js";
import { GitOrchestrator } from "./git.js";
import { LlmClient } from "./llm.js";
import { applyPatches, loadContextFiles } from "./patch.js";
import {
  detectTestCommand,
  formatTestFailureLog,
  runTests,
} from "./test-runner.js";

export interface AgentOptions {
  config: AppConfig;
  logger: Logger;
  onProgress?: ProgressCallback;
}

/**
 * Advanced agentic pipeline:
 *   fetch → worktree → LLM patch → self-healing test loop → commit → push → cleanup
 *
 * Supports cooperative cancel via AbortController and hard wall-clock timeout.
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

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const signal = controller.signal;

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

    this.active.add(task.id);
    this.emit(task.id, "running", "task accepted", {
      baseBranch,
      mainRepoPath,
      ...(budgetMs !== undefined ? { timeoutMs: budgetMs } : {}),
    });

    let worktreePath = "";
    let branch = "";
    let commitSha: string | undefined;

    try {
      throwIfAborted(signal);

      // 1) Isolated worktree on aero-agent/<task_id>
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

      // 2) Resolve test command
      const detected = task.testCommand
        ? { command: task.testCommand, reason: "task override" }
        : await detectTestCommand(worktreePath);
      this.log.info("test command selected", {
        command: detected.command,
        reason: detected.reason,
      });

      // 3) Initial LLM patch from prompt
      await this.applyLlmTurn({
        task,
        worktreePath,
        attempt: 1,
        maxAttempts: maxRetries,
        signal,
      });
      throwIfAborted(signal);

      // 4) Self-healing recursive test loop (up to MAX_TEST_RETRIES)
      const green = await this.selfHealingTestLoop({
        task,
        worktreePath,
        testCommand: detected.command,
        maxRetries,
        testAttempts,
        signal,
      });
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

      // 5) Auto-commit + push
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

      const finishedAt = new Date();
      const result: AgentResult = {
        taskId: task.id,
        status: "succeeded",
        branch,
        worktreePath,
        ...(commitSha !== undefined ? { commitSha } : {}),
        pushRemote: remote,
        testAttempts,
        summary: `Branch ${branch} pushed at ${commitSha ?? "HEAD"}`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedMs,
      };
      this.emit(task.id, "succeeded", result.summary, {
        ...(commitSha !== undefined ? { commitSha } : {}),
        branch,
      });
      return result;
    } catch (err) {
      if (isTaskAbortedError(err)) {
        const status = "cancelled" as const;
        this.log.warn("task aborted", {
          taskId: task.id,
          code: err.code,
          error: err.message,
        });
        this.emit(task.id, "cancelled", err.message, { code: err.code });
        return {
          taskId: task.id,
          status,
          branch: branch || `aero-agent/${task.id}`,
          worktreePath: worktreePath || "",
          ...(commitSha !== undefined ? { commitSha } : {}),
          testAttempts,
          summary: err.code === "timeout" ? "task timed out" : "task cancelled",
          error: err.message,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
        };
      }

      const message = err instanceof Error ? err.message : String(err);
      this.log.error("task failed", { taskId: task.id, error: message });
      this.emit(task.id, "failed", message);
      return {
        taskId: task.id,
        status: "failed",
        branch: branch || `aero-agent/${task.id}`,
        worktreePath: worktreePath || "",
        ...(commitSha !== undefined ? { commitSha } : {}),
        testAttempts,
        summary: "task failed",
        error: message,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.controllers.delete(task.id);
      // 6) Always reclaim disk: git worktree remove
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

  /**
   * Recursive self-healing loop:
   * run tests → on failure capture logs → LLM corrective patch → retry
   * until green or maxRetries exhausted.
   */
  private async selfHealingTestLoop(params: {
    task: AgentTask;
    worktreePath: string;
    testCommand: string;
    maxRetries: number;
    testAttempts: TestAttempt[];
    signal: AbortSignal;
    attempt?: number;
  }): Promise<boolean> {
    throwIfAborted(params.signal);
    const attempt = params.attempt ?? 1;
    this.emit(params.task.id, "testing", `test attempt ${attempt}/${params.maxRetries}`, {
      testCommand: params.testCommand,
    });

    // Per-test command timeout is capped by remaining overall budget when set.
    const result = await runTests(
      params.worktreePath,
      params.testCommand,
      this.log,
      {
        signal: params.signal,
        timeoutMs: 600_000,
      },
    );

    if (result.exitCode === 0) {
      params.testAttempts.push({ attempt, result, healed: false });
      return true;
    }

    const failureLog = formatTestFailureLog(result);
    this.log.warn("tests failed", {
      attempt,
      exitCode: result.exitCode,
    });

    if (attempt >= params.maxRetries) {
      params.testAttempts.push({ attempt, result, healed: false });
      return false;
    }

    throwIfAborted(params.signal);
    this.emit(params.task.id, "healing", `healing from test failure (attempt ${attempt})`);
    await this.applyLlmTurn({
      task: params.task,
      worktreePath: params.worktreePath,
      attempt: attempt + 1,
      maxAttempts: params.maxRetries,
      testFailureLog: failureLog,
      signal: params.signal,
    });
    params.testAttempts.push({ attempt, result, healed: true });

    return this.selfHealingTestLoop({
      ...params,
      attempt: attempt + 1,
    });
  }

  private async applyLlmTurn(params: {
    task: AgentTask;
    worktreePath: string;
    attempt: number;
    maxAttempts: number;
    signal: AbortSignal;
    testFailureLog?: string;
  }): Promise<void> {
    throwIfAborted(params.signal);
    const fileTree = await listFiles(params.worktreePath, {
      maxDepth: 5,
      maxFiles: 400,
    });

    const contextPaths =
      params.task.contextPaths && params.task.contextPaths.length > 0
        ? params.task.contextPaths
        : fileTree.slice(0, 40);

    const files = await loadContextFiles(params.worktreePath, contextPaths);

    const response = await this.llm.generatePatches({
      prompt: params.task.prompt,
      fileTree,
      files,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      signal: params.signal,
      ...(params.testFailureLog !== undefined
        ? { testFailureLog: params.testFailureLog }
        : {}),
    });

    throwIfAborted(params.signal);

    if (response.giveUp) {
      throw new Error(
        `LLM gave up: ${response.reason ?? response.summary}`,
      );
    }

    if (response.patches.length === 0) {
      this.log.info("LLM returned zero patches", {
        summary: response.summary,
      });
      return;
    }

    const applied = await applyPatches(
      params.worktreePath,
      response.patches,
      this.log,
    );
    this.log.info("LLM patches applied", {
      summary: response.summary,
      applied: applied.applied,
      skipped: applied.skipped,
    });
  }

  private emit(
    taskId: string,
    status: Parameters<ProgressCallback>[0]["status"],
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
