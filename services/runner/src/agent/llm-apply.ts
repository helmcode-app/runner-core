import type { Logger } from "../logger.js";
import type { AgentTask, ProgressCallback } from "../types.js";
import { throwIfAborted } from "../util/errors.js";
import type { AgentMemory } from "./events.js";
import { pushAgentEvent } from "./events.js";
import type { LlmClient } from "./llm.js";
import { applyPatches } from "./patch.js";
import { SELF_HEALING_PROMPT_TEMPLATE } from "./prompts.js";
import { truncate } from "./params.js";

export interface LlmApplyArgs {
  task: AgentTask;
  worktreePath: string;
  files: Record<string, string>;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  mem: AgentMemory;
  stageLabel: string;
  testFailureLog?: string;
  healingPrompt?: boolean;
}

/**
 * One LLM → structured full-file patches → disk apply cycle.
 * Shared by the initial edit and self-healing retries.
 */
export async function invokeLlmAndApplyPatches(
  llm: LlmClient,
  log: Logger,
  onProgress: ProgressCallback | undefined,
  args: LlmApplyArgs,
): Promise<void> {
  throwIfAborted(args.signal);

  pushAgentEvent(
    args.mem,
    {
      taskId: args.task.id,
      status: "running",
      stage: "llm_invoke",
      cycle: args.attempt,
      message: `invoking LLM (${args.stageLabel}, attempt ${args.attempt}/${args.maxAttempts})`,
      at: new Date().toISOString(),
      detail: {
        contextFiles: Object.keys(args.files),
        healing: Boolean(args.healingPrompt),
      },
    },
    log,
    onProgress,
  );

  const prompt =
    args.healingPrompt && args.testFailureLog
      ? `${args.task.prompt}\n\n${SELF_HEALING_PROMPT_TEMPLATE}${truncate(args.testFailureLog, 40_000)}`
      : args.task.prompt;

  const response = await llm.generatePatches({
    prompt,
    fileTree: Object.keys(args.files),
    files: args.files,
    attempt: args.attempt,
    maxAttempts: args.maxAttempts,
    signal: args.signal,
    ...(args.testFailureLog !== undefined
      ? { testFailureLog: args.testFailureLog }
      : {}),
  });

  throwIfAborted(args.signal);

  if (response.giveUp) {
    throw new Error(`LLM gave up: ${response.reason ?? response.summary}`);
  }

  if (response.patches.length === 0) {
    log.info("LLM returned zero patches", { summary: response.summary });
    pushAgentEvent(
      args.mem,
      {
        taskId: args.task.id,
        status: "running",
        stage: "llm_patched",
        cycle: args.attempt,
        message: `LLM returned no file changes: ${response.summary}`,
        at: new Date().toISOString(),
      },
      log,
      onProgress,
    );
    return;
  }

  const applied = await applyPatches(args.worktreePath, response.patches, log);

  pushAgentEvent(
    args.mem,
    {
      taskId: args.task.id,
      status: "running",
      stage: "llm_patched",
      cycle: args.attempt,
      message: `applied ${applied.applied.length} file rewrite(s): ${response.summary}`,
      at: new Date().toISOString(),
      detail: {
        summary: response.summary,
        applied: applied.applied,
        skipped: applied.skipped,
      },
    },
    log,
    onProgress,
  );
}
