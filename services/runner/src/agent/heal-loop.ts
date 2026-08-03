import type { Logger } from "../logger.js";
import type {
  AgentTask,
  ProgressCallback,
  TestAttempt,
} from "../types.js";
import { throwIfAborted } from "../util/errors.js";
import type { ContextBuilder } from "./contextBuilder.js";
import type { AgentMemory } from "./events.js";
import { pushAgentEvent } from "./events.js";
import type { LlmClient } from "./llm.js";
import { invokeLlmAndApplyPatches } from "./llm-apply.js";
import { truncate } from "./params.js";
import { formatTestFailureLog, runTests } from "./test-runner.js";

export interface RunTestAndHealArgs {
  workspacePath: string;
  currentCycle: number;
  maxCycles: number;
  testCommand: string;
  task: AgentTask;
  /** Fallback surgical context if refresh returns empty. */
  files: Record<string, string>;
  testAttempts: TestAttempt[];
  signal: AbortSignal;
  mem: AgentMemory;
}

export interface HealLoopDeps {
  llm: LlmClient;
  contextBuilder: ContextBuilder;
  log: Logger;
  onProgress?: ProgressCallback;
}

/**
 * Recursive self-healing loop.
 *
 * Runs `testCommand` in the sandbox worktree. On failure, if cycles remain,
 * intercepts the log, applies an LLM rewrite, and recurses — without
 * treating intermediate failures as user-facing terminal errors.
 */
export async function runTestAndHeal(
  deps: HealLoopDeps,
  args: RunTestAndHealArgs,
): Promise<boolean> {
  const {
    workspacePath,
    currentCycle,
    maxCycles,
    testCommand,
    task,
    files,
    testAttempts,
    signal,
    mem,
  } = args;
  const { log, onProgress, llm, contextBuilder } = deps;

  throwIfAborted(signal);

  pushAgentEvent(
    mem,
    {
      taskId: task.id,
      status: "testing",
      stage: "testing",
      cycle: currentCycle,
      message: `running tests (cycle ${currentCycle}/${maxCycles})`,
      at: new Date().toISOString(),
      detail: { testCommand },
    },
    log,
    onProgress,
  );

  const result = await runTests(workspacePath, testCommand, log, {
    signal,
    timeoutMs: 600_000,
  });

  if (result.exitCode === 0) {
    testAttempts.push({
      attempt: currentCycle,
      result,
      healed: false,
    });
    pushAgentEvent(
      mem,
      {
        taskId: task.id,
        status: "testing",
        stage: "test_passed",
        cycle: currentCycle,
        message: `tests green on cycle ${currentCycle}`,
        at: new Date().toISOString(),
        detail: {
          exitCode: 0,
          durationMs: result.durationMs,
        },
      },
      log,
      onProgress,
    );
    return true;
  }

  const failureLog = formatTestFailureLog(result);
  log.warn("tests failed", {
    cycle: currentCycle,
    exitCode: result.exitCode,
  });

  pushAgentEvent(
    mem,
    {
      taskId: task.id,
      status: "testing",
      stage: "test_failed",
      cycle: currentCycle,
      message: `Cycle ${currentCycle} failed. Catching compile error. Initiating self-healing...`,
      at: new Date().toISOString(),
      detail: {
        exitCode: result.exitCode,
        stdout: truncate(result.stdout, 4_000),
        stderr: truncate(result.stderr, 4_000),
        durationMs: result.durationMs,
      },
    },
    log,
    onProgress,
  );

  if (currentCycle >= maxCycles) {
    testAttempts.push({
      attempt: currentCycle,
      result,
      healed: false,
    });
    pushAgentEvent(
      mem,
      {
        taskId: task.id,
        status: "failed",
        stage: "failed",
        cycle: currentCycle,
        message: `self-healing exhausted after ${maxCycles} cycle(s)`,
        at: new Date().toISOString(),
        detail: { exitCode: result.exitCode },
      },
      log,
      onProgress,
    );
    return false;
  }

  throwIfAborted(signal);

  pushAgentEvent(
    mem,
    {
      taskId: task.id,
      status: "healing",
      stage: "self_healing",
      cycle: currentCycle,
      message: `self-healing cycle ${currentCycle} → ${currentCycle + 1}`,
      at: new Date().toISOString(),
    },
    log,
    onProgress,
  );

  const refreshed = await contextBuilder.build(
    workspacePath,
    task.contextPaths,
  );
  const contextFiles =
    Object.keys(refreshed.files).length > 0 ? refreshed.files : files;

  await invokeLlmAndApplyPatches(llm, log, onProgress, {
    task,
    worktreePath: workspacePath,
    files: contextFiles,
    attempt: currentCycle + 1,
    maxAttempts: maxCycles,
    signal,
    mem,
    stageLabel: "heal",
    testFailureLog: failureLog,
    healingPrompt: true,
  });

  testAttempts.push({
    attempt: currentCycle,
    result,
    healed: true,
  });

  return runTestAndHeal(deps, {
    workspacePath,
    currentCycle: currentCycle + 1,
    maxCycles,
    testCommand,
    task,
    files: contextFiles,
    testAttempts,
    signal,
    mem,
  });
}
