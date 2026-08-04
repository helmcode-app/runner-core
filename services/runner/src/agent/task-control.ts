import type { AppConfig } from "../config.js";
import type { AgentTask } from "../types.js";
import { TaskAbortedError } from "../util/errors.js";

/**
 * Per-task AbortController + optional wall-clock timeout.
 * Stores the controller in the provided map for cancel().
 */
export function beginTaskControl(
  task: AgentTask,
  config: AppConfig,
  controllers: Map<string, AbortController>,
): { signal: AbortSignal; clearTimeoutBudget: () => void } {
  const controller = new AbortController();
  controllers.set(task.id, controller);

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
