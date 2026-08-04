/**
 * In-process interactive PTY (no Docker socket).
 * Spawns a shell in the runner process namespace via node-pty.
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { applyHelmShellInit } from "./shell-init.js";

export interface LocalPtyOptions {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export interface LocalPty {
  readonly sessionId: string;
  readonly shell: string;
  readonly cwd: string;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(
    listener: (e: { exitCode: number; signal?: number }) => void,
  ): void;
}

/**
 * Resolve shell binary + args.
 * Supports simple strings: `/bin/bash`, `bash -l`, `/bin/sh`.
 */
export function resolveShellCmd(shell: string): { file: string; args: string[] } {
  const s = shell.trim() || "/bin/bash";
  if (s.includes(" ")) {
    const parts = s.split(/\s+/);
    return { file: parts[0]!, args: parts.slice(1) };
  }
  if (s.endsWith("bash") || s === "bash") return { file: s, args: ["-l"] };
  if (s.endsWith("zsh") || s === "zsh") return { file: s, args: ["-l"] };
  return { file: s, args: [] };
}

/** Prefer configured shell; fall back to bash → sh. */
export function pickAvailableShell(preferred: string): {
  file: string;
  args: string[];
  display: string;
} {
  const candidates = [
    preferred,
    "/bin/bash",
    "bash",
    "/bin/sh",
    "sh",
  ];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const resolved = resolveShellCmd(key);
    if (isExecutable(resolved.file)) {
      return {
        file: resolved.file,
        args: resolved.args,
        display: [resolved.file, ...resolved.args].join(" "),
      };
    }
  }
  // Last resort — let spawn fail with a clear OS error.
  const fallback = resolveShellCmd(preferred || "/bin/sh");
  return {
    file: fallback.file,
    args: fallback.args,
    display: [fallback.file, ...fallback.args].join(" "),
  };
}

function isExecutable(file: string): boolean {
  if (!file.includes("/") && !file.startsWith(".")) {
    // bare name — rely on PATH at spawn time
    return true;
  }
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function spawnLocalPty(opts: LocalPtyOptions): LocalPty {
  const picked = pickAvailableShell(opts.shell);
  const sessionId = randomUUID();

  // Color-friendly defaults for interactive WebSSH (xterm.js client).
  // Callers may still override via opts.env.
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR: "1",
    CLICOLOR_FORCE: "1",
    FORCE_COLOR: "1",
    HELM_TERMINAL: "1",
    ...opts.env,
  };

  // Avoid leaking parent interactive flags that confuse shells.
  delete baseEnv.npm_config_argv;

  // Inject common aliases (ls --color, git shortcuts, …) for bash/zsh.
  const launched = applyHelmShellInit(picked.file, picked.args, baseEnv);

  const term = pty.spawn(launched.file, launched.args, {
    name: "xterm-256color",
    cols: Math.max(1, opts.cols),
    rows: Math.max(1, opts.rows),
    cwd: opts.cwd,
    env: launched.env,
  });

  return {
    sessionId,
    shell: launched.display,
    cwd: opts.cwd,
    write(data) {
      if (typeof data === "string") term.write(data);
      else term.write(data.toString("utf8"));
    },
    resize(cols, rows) {
      term.resize(Math.max(1, cols), Math.max(1, rows));
    },
    kill(signal = "SIGTERM") {
      try {
        term.kill(signal);
      } catch {
        /* already dead */
      }
    },
    onData(listener) {
      term.onData(listener);
    },
    onExit(listener) {
      term.onExit(listener);
    },
  };
}
