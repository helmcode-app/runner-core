import path from "node:path";
import type { Logger } from "../logger.js";
import type { CommandResult } from "../types.js";
import { pathExists } from "../util/fs.js";
import { runShell } from "../util/process.js";

export interface DetectedTestCommand {
  command: string;
  reason: string;
}

/**
 * Auto-detect a sensible local test command from repository markers.
 * Prefer explicit task.testCommand when provided by the caller.
 */
export async function detectTestCommand(
  worktreeRoot: string,
): Promise<DetectedTestCommand> {
  const checks: Array<{ file: string; command: string; reason: string }> = [
    { file: "go.mod", command: "go test ./...", reason: "go.mod present" },
    {
      file: "Cargo.toml",
      command: "cargo test",
      reason: "Cargo.toml present",
    },
    {
      file: "package.json",
      command: "npm test --if-present",
      reason: "package.json present",
    },
    {
      file: "pyproject.toml",
      command: "python -m pytest -q",
      reason: "pyproject.toml present",
    },
    {
      file: "requirements.txt",
      command: "python -m pytest -q",
      reason: "requirements.txt present",
    },
    {
      file: "Makefile",
      command: "make test",
      reason: "Makefile present",
    },
  ];

  for (const c of checks) {
    if (await pathExists(path.join(worktreeRoot, c.file))) {
      return { command: c.command, reason: c.reason };
    }
  }

  return {
    command: "true",
    reason: "no project markers found; noop success",
  };
}

export async function runTests(
  worktreeRoot: string,
  testCommand: string,
  log: Logger,
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  log.info("running tests", { testCommand, cwd: worktreeRoot });
  const result = await runShell(testCommand, {
    cwd: worktreeRoot,
    timeoutMs: opts.timeoutMs ?? 600_000,
    maxOutputChars: 512 * 1024,
  });
  log.info("tests finished", {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  });
  return result;
}

export function formatTestFailureLog(result: CommandResult): string {
  return [
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `exitCode: ${result.exitCode}`,
    `durationMs: ${result.durationMs}`,
    "--- stdout ---",
    result.stdout || "(empty)",
    "--- stderr ---",
    result.stderr || "(empty)",
  ].join("\n");
}
