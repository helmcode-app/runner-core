/** Thrown when a task is aborted via cancel or hard timeout. */
export class TaskAbortedError extends Error {
  readonly code: "cancelled" | "timeout";

  constructor(code: "cancelled" | "timeout", message?: string) {
    super(
      message ??
        (code === "timeout" ? "task timed out" : "task cancelled"),
    );
    this.name = "TaskAbortedError";
    this.code = code;
  }
}

export function isTaskAbortedError(err: unknown): err is TaskAbortedError {
  return err instanceof TaskAbortedError;
}

export function abortReasonToError(reason: unknown): TaskAbortedError {
  if (reason instanceof TaskAbortedError) return reason;
  if (reason instanceof Error && /timeout/i.test(reason.message)) {
    return new TaskAbortedError("timeout", reason.message);
  }
  if (typeof reason === "string" && /timeout/i.test(reason)) {
    return new TaskAbortedError("timeout", reason);
  }
  return new TaskAbortedError(
    "cancelled",
    reason instanceof Error ? reason.message : undefined,
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortReasonToError(signal.reason);
}
