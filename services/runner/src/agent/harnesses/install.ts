/**
 * Shared install / PATH helpers for managed ACP harnesses.
 */

import { existsSync } from "node:fs";
import { access, constants, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../util/process.js";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isFloatingTag(version: string): boolean {
  const v = version.trim().toLowerCase();
  return (
    v === "latest" ||
    v === "next" ||
    v === "beta" ||
    v === "dev" ||
    v.startsWith("latest-")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Container user `helm` uses HOME=/app; persist `/app/.helm/<id>` as a volume. */
export function defaultHarnessPrefix(harnessId: string): string {
  const home = process.env.HOME?.trim() || os.homedir();
  if (home === "/app") return path.join("/app/.helm", harnessId);
  return path.join(home, ".helm", harnessId);
}

/**
 * OpenCode install prefix. Container path stays `/app/.opencode` so the
 * compose.dev `dev-opencode` volume keeps working.
 */
export function defaultOpenCodePrefix(): string {
  const home = process.env.HOME?.trim() || os.homedir();
  if (home === "/app") return "/app/.opencode";
  return path.join(home, ".helm", "opencode");
}

export function resolveHarnessBinPath(settings: {
  bin?: string;
  prefix: string;
  binName: string;
}): string {
  if (settings.bin?.trim()) return settings.bin.trim();
  return path.join(settings.prefix, "bin", settings.binName);
}

export function npmPackageSpec(packageName: string, version: string): string {
  const v = version.trim() || "latest";
  return `${packageName}@${v}`;
}

export function findOnPath(names: string[]): string | undefined {
  const dirs = collectPathDirs();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    if (trimmed.includes(path.sep) || path.isAbsolute(trimmed)) {
      if (existsSync(trimmed)) return trimmed;
      continue;
    }
    for (const dir of dirs) {
      const candidate = path.join(dir, trimmed);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function collectPathDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string): void => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) add(dir);
  const home = process.env.HOME?.trim() || os.homedir();
  if (home) add(path.join(home, ".local", "bin"));
  add("/usr/local/bin");
  add("/opt/homebrew/bin");
  return dirs;
}

export async function installNpmPackage(opts: {
  npmBin: string;
  prefix: string;
  spec: string;
  timeoutMs: number;
}): Promise<{ durationMs: number; stdout: string; stderr: string }> {
  await mkdir(opts.prefix, { recursive: true });
  const result = await runCommand(
    opts.npmBin,
    ["install", "-g", "--prefix", opts.prefix, opts.spec],
    {
      cwd: opts.prefix,
      timeoutMs: opts.timeoutMs,
      maxOutputChars: 256 * 1024,
      env: {
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
      },
    },
  );
  if (result.exitCode !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`Failed to install ${opts.spec}: ${detail}`);
  }
  return {
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
