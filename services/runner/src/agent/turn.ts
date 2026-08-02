import type { Logger } from "../logger.js";
import type { AgentTask } from "../types.js";
import { throwIfAborted } from "../util/errors.js";
import { listFiles } from "../util/fs.js";
import type { LlmClient } from "./llm.js";
import { applyPatches, loadContextFiles } from "./patch.js";

export interface LlmTurnParams {
  task: AgentTask;
  worktreePath: string;
  attempt: number;
  maxAttempts: number;
  signal: AbortSignal;
  testFailureLog?: string;
}

/**
 * One LLM → patch cycle inside a worktree.
 * Shared by the initial edit and self-healing retries.
 */
export async function applyLlmTurn(
  llm: LlmClient,
  log: Logger,
  params: LlmTurnParams,
): Promise<void> {
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

  const response = await llm.generatePatches({
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
    throw new Error(`LLM gave up: ${response.reason ?? response.summary}`);
  }

  if (response.patches.length === 0) {
    log.info("LLM returned zero patches", { summary: response.summary });
    return;
  }

  const applied = await applyPatches(
    params.worktreePath,
    response.patches,
    log,
  );
  log.info("LLM patches applied", {
    summary: response.summary,
    applied: applied.applied,
    skipped: applied.skipped,
  });
}
