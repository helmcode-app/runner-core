import { spawn } from "node:child_process";
import type { CommandResult } from "../types.js";

export interface RunCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Max characters retained for stdout/stderr (default 512 KiB). */
  maxOutputChars?: number;
  input?: string;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head - 32;
  return `${s.slice(0, head)}\n…[truncated ${s.length - max} chars]…\n${s.slice(-tail)}`;
}

/**
 * Spawn a process and collect stdout/stderr. Never throws on non-zero exit;
 * throws only on spawn failure or timeout.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
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
    let settled = false;

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;

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
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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
