import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  AgentResult,
  AgentRunParams,
  AgentTask,
  ProgressCallback,
  TestAttempt,
} from "../types.js";
import {
  isTaskAbortedError,
  TaskAbortedError,
  throwIfAborted,
} from "../util/errors.js";
import { ContextBuilder } from "./contextBuilder.js";
import {
  createAgentMemory,
  pushAgentEvent,
  type AgentMemory,
} from "./events.js";
import { branchNameForTask, GitOrchestrator } from "./git.js";
import { resolveGithubToken } from "../util/github-token.js";
import { runTestAndHeal } from "./heal-loop.js";
import { LlmClient } from "./llm.js";
import { invokeLlmAndApplyPatches } from "./llm-apply.js";
import {
  agentRunParamsToTask,
  resolveMaxCycles,
  summarizePrompt,
} from "./params.js";
import { DEFAULT_MAX_CYCLES, SELF_HEALING_PROMPT_TEMPLATE } from "./prompts.js";
import { detectTestCommand } from "./test-runner.js";

export type { AgentMemory } from "./events.js";
export { agentRunParamsToTask } from "./params.js";
export { DEFAULT_MAX_CYCLES, SELF_HEALING_PROMPT_TEMPLATE } from "./prompts.js";

export interface HelmCodeAgentEngineOptions {
  config: AppConfig;
  logger: Logger;
  onProgress?: ProgressCallback;
  /** Optional shared ContextBuilder; a default is created when omitted. */
  contextBuilder?: ContextBuilder;
}

/**
 * Official HelmCode agent orchestration engine.
 *
 * Pipeline: worktree → ContextBuilder → LLM structured patches →
 * recursive runTestAndHeal (max 3) → auto-commit → push aero-agent/<taskId>.
 *
 * Accepts JSON-RPC `agent/run` params from the iPad WebSocket path.
 */
export class HelmCodeAgentEngine {
  private readonly git: GitOrchestrator;
  private readonly llm: LlmClient;
  private readonly contextBuilder: ContextBuilder;
  private readonly log: Logger;
  private readonly onProgress: ProgressCallback | undefined;
  private readonly active = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly memory = new Map<string, AgentMemory>();

  constructor(private readonly opts: HelmCodeAgentEngineOptions) {
    this.log = opts.logger.child({ component: "HelmCodeAgentEngine" });
    this.git = new GitOrchestrator(opts.config, this.log);
    this.llm = new LlmClient(opts.config, this.log);
    this.contextBuilder =
      opts.contextBuilder ??
      new ContextBuilder({
        log: this.log.child({ component: "ContextBuilder" }),
      });
    this.onProgress = opts.onProgress;
  }

  get activeTaskCount(): number {
    return this.active.size;
  }

  isRunning(taskId: string): boolean {
    return this.active.has(taskId);
  }

  getMemory(taskId: string): AgentMemory | undefined {
    return this.memory.get(taskId);
  }

  listMemory(): AgentMemory[] {
    return [...this.memory.values()];
  }

  /** Returns true if a running task was signalled to abort. */
  cancel(taskId: string, reason = "cancelled by client"): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller || controller.signal.aborted) return false;
    this.log.info("cancel requested", { taskId, reason });
    controller.abort(new TaskAbortedError("cancelled", reason));
    return true;
  }

  /** Run from raw `agent/run` JSON-RPC params. */
  async runFromParams(params: AgentRunParams): Promise<AgentResult> {
    return this.run(agentRunParamsToTask(params));
  }

  /**
   * Full orchestration cycle for one agent task.
   *
   * 1. Isolated worktree on aero-agent/<taskId>
   * 2. Surgical context (contextPaths only)
   * 3. Initial LLM file rewrites
   * 4. Detect / use test command
   * 5. Self-heal loop (max cycles)
   * 6. Commit + push shadow branch
   */
  async run(taskInput: AgentTask): Promise<AgentResult> {
    const task: AgentTask = {
      ...taskInput,
      id: taskInput.id?.trim() || randomUUID(),
    };
    if (!task.prompt?.trim()) {
      throw new Error("prompt is required");
    }

    const startedAt = new Date();
    const startedMs = Date.now();
    const config = this.opts.config;
    const mainRepoPath = task.repoPath ?? config.MAIN_REPO_PATH;
    const baseBranch = task.baseBranch ?? config.DEFAULT_BASE_BRANCH;
    // Real GitHub PAT only. Open Project / OPENCORE_API_TOKEN is never used for git.
    const token = resolveGithubToken(task.githubToken, config.GITHUB_TOKEN);
    const remote = task.remote ?? "origin";
    const maxCycles = resolveMaxCycles(task, config);
    const testAttempts: TestAttempt[] = [];
    const branch = branchNameForTask(task.id);

    const mem = createAgentMemory(task.id, branch, startedAt.toISOString());
    this.memory.set(task.id, mem);

    const { signal, clearTimeoutBudget } = this.beginTaskControl(task);
    this.active.add(task.id);

    this.emit(mem, {
      taskId: task.id,
      status: "running",
      stage: "accepted",
      message: "task accepted; starting agent pipeline",
      at: new Date().toISOString(),
      detail: { baseBranch, mainRepoPath, maxCycles },
    });

    let worktreePath = "";
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

      this.emit(mem, {
        taskId: task.id,
        status: "running",
        stage: "worktree_ready",
        message: `worktree ready on branch ${handle.branch}`,
        at: new Date().toISOString(),
        detail: { worktreePath, branch: handle.branch },
      });
      throwIfAborted(signal);

      const built = await this.contextBuilder.build(
        worktreePath,
        task.contextPaths,
      );
      this.emit(mem, {
        taskId: task.id,
        status: "running",
        stage: "context_built",
        message: `context built: ${built.loaded.length} file(s), ${built.totalBytes} bytes`,
        at: new Date().toISOString(),
        detail: {
          loaded: built.loaded,
          skipped: built.skipped,
          totalBytes: built.totalBytes,
        },
      });

      await invokeLlmAndApplyPatches(this.llm, this.log, this.onProgress, {
        task,
        worktreePath,
        files: built.files,
        attempt: 1,
        maxAttempts: maxCycles,
        signal,
        mem,
        stageLabel: "initial",
      });
      throwIfAborted(signal);

      const detected = task.testCommand
        ? { command: task.testCommand, reason: "task override" }
        : await detectTestCommand(worktreePath);
      this.log.info("test command selected", {
        command: detected.command,
        reason: detected.reason,
      });

      const green = await runTestAndHeal(
        {
          llm: this.llm,
          contextBuilder: this.contextBuilder,
          log: this.log,
          ...(this.onProgress !== undefined
            ? { onProgress: this.onProgress }
            : {}),
        },
        {
          workspacePath: worktreePath,
          currentCycle: 1,
          maxCycles,
          testCommand: detected.command,
          task,
          files: built.files,
          testAttempts,
          signal,
          mem,
        },
      );
      throwIfAborted(signal);

      if (!green) {
        const last = testAttempts[testAttempts.length - 1];
        throw new Error(
          `tests still failing after ${maxCycles} cycle(s)` +
            (last
              ? `\nlast exit ${last.result.exitCode}: ${last.result.stderr || last.result.stdout}`
              : ""),
        );
      }

      const promptSummary = summarizePrompt(task.prompt);
      const commitMessage = `AI Auto-Refactor [HelmCode]: ${promptSummary}`;

      this.emit(mem, {
        taskId: task.id,
        status: "committing",
        stage: "committing",
        message: "tests green; committing changes",
        at: new Date().toISOString(),
        detail: { commitMessage },
      });

      commitSha = await this.git.commit(worktreePath, commitMessage, signal);

      this.emit(mem, {
        taskId: task.id,
        status: "pushing",
        stage: "pushing",
        message: `pushing shadow branch ${branch} to ${remote}`,
        at: new Date().toISOString(),
        detail: { branch, commitSha, remote },
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

      this.emit(mem, {
        taskId: task.id,
        status: "succeeded",
        stage: "success",
        message: result.summary,
        at: new Date().toISOString(),
        detail: {
          commitSha,
          branch,
          testAttempts: testAttempts.length,
        },
      });

      mem.result = result;
      mem.liveStatus = "succeeded";
      return result;
    } catch (err) {
      const result = this.finishError({
        err,
        task,
        branch,
        worktreePath,
        ...(commitSha !== undefined ? { commitSha } : {}),
        testAttempts,
        startedAt,
        startedMs,
        mem,
      });
      mem.result = result;
      mem.liveStatus = result.status;
      return result;
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

  private emit(
    mem: AgentMemory,
    event: Parameters<typeof pushAgentEvent>[1],
  ): void {
    pushAgentEvent(mem, event, this.log, this.onProgress);
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
    status: Extract<AgentResult["status"], "succeeded">;
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
    mem: AgentMemory;
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
      this.log.warn("task aborted", {
        taskId: args.task.id,
        code: args.err.code,
        error: args.err.message,
      });
      this.emit(args.mem, {
        taskId: args.task.id,
        status: "cancelled",
        stage: "cancelled",
        message: args.err.message,
        at: new Date().toISOString(),
        detail: { code: args.err.code },
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
    this.emit(args.mem, {
      taskId: args.task.id,
      status: "failed",
      stage: "failed",
      message,
      at: new Date().toISOString(),
    });
    return {
      ...base,
      status: "failed",
      summary: "task failed",
      error: message,
    };
  }
}
