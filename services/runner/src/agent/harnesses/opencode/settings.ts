/**
 * OpenCode ACP harness install + spawn settings.
 *
 * Defaults live here. Put local overrides in OPENCODE_HARNESS_OVERLAY
 * (same idea as OpenCode's own config overlay). Do not add these to `.env`.
 */

import os from "node:os";
import path from "node:path";

export interface OpenCodeModeIds {
  agent: string;
  plan: string;
  ask: string;
}

export interface OpenCodeHarnessSettings {
  packageName: string;
  version: string;
  /** npm `--prefix` for managed install. */
  prefix: string;
  /** Override binary path (default `$prefix/bin/opencode`). */
  bin?: string;
  /** HOME for auth.json / OpenCode config (default process HOME). */
  home?: string;
  npmBin: string;
  installTimeoutMs: number;
  /** 0 = install at boot only, no periodic update. */
  updateIntervalHours: number;
  modes: OpenCodeModeIds;
}

export const OPENCODE_HARNESS_DEFAULTS = {
  packageName: "opencode-ai",
  version: "latest",
  npmBin: "npm",
  installTimeoutMs: 600_000,
  updateIntervalHours: 24,
  modes: {
    agent: "build",
    plan: "plan",
    ask: "ask",
  },
} as const satisfies Omit<OpenCodeHarnessSettings, "prefix" | "bin" | "home">;

/**
 * Local overrides. Leave empty to use defaults.
 *
 * @example
 * export const OPENCODE_HARNESS_OVERLAY = {
 *   version: "1.18.18",
 *   updateIntervalHours: 0,
 * };
 */
export const OPENCODE_HARNESS_OVERLAY: Partial<OpenCodeHarnessSettings> = {};

/** Container user `helm` uses HOME=/app; persist `/app/.opencode` as a volume. */
export function defaultOpenCodePrefix(): string {
  const home = process.env.HOME?.trim() || os.homedir();
  if (home === "/app") return "/app/.opencode";
  return path.join(home, ".helm", "opencode");
}

export function resolveOpenCodeHarnessSettings(
  overlay?: Partial<OpenCodeHarnessSettings>,
): OpenCodeHarnessSettings {
  const bin = overlay?.bin ?? OPENCODE_HARNESS_OVERLAY.bin;
  const home = overlay?.home ?? OPENCODE_HARNESS_OVERLAY.home;
  return {
    packageName:
      overlay?.packageName ??
      OPENCODE_HARNESS_OVERLAY.packageName ??
      OPENCODE_HARNESS_DEFAULTS.packageName,
    version:
      overlay?.version ??
      OPENCODE_HARNESS_OVERLAY.version ??
      OPENCODE_HARNESS_DEFAULTS.version,
    prefix:
      overlay?.prefix ??
      OPENCODE_HARNESS_OVERLAY.prefix ??
      defaultOpenCodePrefix(),
    ...(bin?.trim() ? { bin: bin.trim() } : {}),
    ...(home?.trim() ? { home: home.trim() } : {}),
    npmBin:
      overlay?.npmBin ??
      OPENCODE_HARNESS_OVERLAY.npmBin ??
      OPENCODE_HARNESS_DEFAULTS.npmBin,
    installTimeoutMs:
      overlay?.installTimeoutMs ??
      OPENCODE_HARNESS_OVERLAY.installTimeoutMs ??
      OPENCODE_HARNESS_DEFAULTS.installTimeoutMs,
    updateIntervalHours:
      overlay?.updateIntervalHours ??
      OPENCODE_HARNESS_OVERLAY.updateIntervalHours ??
      OPENCODE_HARNESS_DEFAULTS.updateIntervalHours,
    modes: {
      ...OPENCODE_HARNESS_DEFAULTS.modes,
      ...OPENCODE_HARNESS_OVERLAY.modes,
      ...overlay?.modes,
    },
  };
}
