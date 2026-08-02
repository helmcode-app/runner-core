import type { Logger } from "../logger.js";
import type { AgentTask, ProgressCallback, TestAttempt } from "../types.js";
import { throwIfAborted } from "../util/errors.js";
import type { LlmClient } from "./llm.js";
import {
  formatTestFailureLog,
  runTests,
} from "./test-runner.js";
import { applyLlmTurn } from "./turn.js";

export interface HealLoopParams {
  task: AgentTask;
  worktreePath: string;
  testCommand: string;
  maxRetries: number;
  testAttempts: TestAttempt[];
  signal: AbortSignal;
  attempt?: number;
}

/**
 * Self-healing test loop: run tests → on failure LLM patch → retry
 * until green or maxRetries exhausted.
 */
export async function runSelfHealingTests(
  llm: LlmClient,
  log: Logger,
  emit: ProgressCallback,
  params: HealLoopParams,
): Promise<boolean> {
  throwIfAborted(params.signal);
  const attempt = params.attempt ?? 1;

  emit({
    taskId: params.task.id,
    status: "testing",
    message: `test attempt ${attempt}/${params.maxRetries}`,
    at: new Date().toISOString(),
    detail: { testCommand: params.testCommand },
  });

  const result = await runTests(
    params.worktreePath,
    params.testCommand,
    log,
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
  log.warn("tests failed", {
    attempt,
    exitCode: result.exitCode,
  });

  if (attempt >= params.maxRetries) {
    params.testAttempts.push({ attempt, result, healed: false });
    return false;
  }

  throwIfAborted(params.signal);
  emit({
    taskId: params.task.id,
    status: "healing",
    message: `healing from test failure (attempt ${attempt})`,
    at: new Date().toISOString(),
  });

  await applyLlmTurn(llm, log, {
    task: params.task,
    worktreePath: params.worktreePath,
    attempt: attempt + 1,
    maxAttempts: params.maxRetries,
    testFailureLog: failureLog,
    signal: params.signal,
  });
  params.testAttempts.push({ attempt, result, healed: true });

  return runSelfHealingTests(llm, log, emit, {
    ...params,
    attempt: attempt + 1,
  });
}
