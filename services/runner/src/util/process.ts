import { spawn } from "node:child_process";
import type { CommandResult } from "../types.js";
import { abortReasonToError, throwIfAborted } from "./errors.js";

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Max characters retained for stdout/stderr (default 512 KiB). */
  maxOutputChars?: number;
  input?: string;
  /** When aborted, the child is SIGKILL'd and the promise rejects with TaskAbortedError. */
  signal?: AbortSignal;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 32;
  return `${s.slice(0, head)}\n…[truncated ${s.length - max} chars]…\n${s.slice(-tail)}`;
}

/**
 * Spawn a process and collect stdout/stderr. Never throws on non-zero exit;
 * throws on spawn failure, command timeout, or AbortSignal.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  throwIfAborted(options.signal);

  const maxOutput = options.maxOutputChars ?? 512 * 1024;
  const started = Date.now();
  const display = [command, ...args].join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGKILL");
    };

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = truncate(stdout + chunk, maxOutput);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = truncate(stderr + chunk, maxOutput);
    });

    if (options.input !== undefined) {
      child.stdin.write(options.input);
    }
    child.stdin.end();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        reject(abortReasonToError(options.signal?.reason));
        return;
      }
      if (timedOut) {
        reject(
          new Error(
            `Command timed out after ${options.timeoutMs}ms: ${display}`,
          ),
        );
        return;
      }
      resolve({
        command: display,
        cwd: options.cwd,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

/** Convenience wrapper: run via `/bin/sh -c` for compound shell expressions. */
export function runShell(
  script: string,
  options: RunCommandOptions,
): Promise<CommandResult> {
  return runCommand("/bin/sh", ["-c", script], options);
}

export async function runCommandOrThrow(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.exitCode !== 0) {
    const err = new Error(
      `Command failed (${result.exitCode}): ${result.command}\n${result.stderr || result.stdout}`,
    );
    (err as Error & { result: CommandResult }).result = result;
    throw err;
  }
  return result;
}
