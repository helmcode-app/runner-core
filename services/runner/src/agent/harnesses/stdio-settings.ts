/**
 * Install + spawn settings for every stdio ACP harness.
 *
 * Defaults come from `catalog.ts`. Put local overrides in the matching
 * `*_HARNESS_OVERLAY` below (OpenCode overlay lives next to auth.json).
 * Do not add these to `.env`.
 */

import type { AgentHarnessId, HarnessSpec } from "./catalog.js";
import { defaultHarnessPrefix } from "./install.js";
import type { HarnessModeIds } from "./types.js";

export interface StdioHarnessSettings {
  packageName?: string;
  version: string;
  prefix: string;
  /** Override binary path (skips prefix/PATH lookup). */
  bin?: string;
  home?: string;
  npmBin: string;
  installTimeoutMs: number;
  /** 0 = install at boot only, no periodic update. */
  updateIntervalHours: number;
  args: string[];
  binName: string;
  pathCandidates: string[];
  requireApiKey: boolean;
  modes: HarnessModeIds;
}

/** Overlay may patch individual mode ids. */
export type HarnessOverlay = Partial<Omit<StdioHarnessSettings, "modes">> & {
  modes?: Partial<HarnessModeIds>;
};

const STDIO_DEFAULTS = {
  version: "latest",
  npmBin: "npm",
  installTimeoutMs: 600_000,
  updateIntervalHours: 24,
} as const;

/**
 * Local overrides per harness. Leave empty to use catalog defaults.
 *
 * @example
 * export const CLAUDE_HARNESS_OVERLAY = { version: "0.12.0" };
 * export const OPENCODE_HARNESS_OVERLAY = { version: "1.18.18" };
 */
export const OPENCODE_HARNESS_OVERLAY: HarnessOverlay = {};
export const CLAUDE_HARNESS_OVERLAY: HarnessOverlay = {};
export const CODEX_HARNESS_OVERLAY: HarnessOverlay = {};
export const CURSOR_HARNESS_OVERLAY: HarnessOverlay = {};
export const GROK_HARNESS_OVERLAY: HarnessOverlay = {};

const OVERLAYS: Record<AgentHarnessId, HarnessOverlay> = {
  opencode: OPENCODE_HARNESS_OVERLAY,
  claude: CLAUDE_HARNESS_OVERLAY,
  codex: CODEX_HARNESS_OVERLAY,
  cursor: CURSOR_HARNESS_OVERLAY,
  grok: GROK_HARNESS_OVERLAY,
};

export function resolveStdioHarnessSettings(
  spec: HarnessSpec,
  overlay?: HarnessOverlay,
): StdioHarnessSettings {
  const fileOverlay = OVERLAYS[spec.id];
  const bin = overlay?.bin ?? fileOverlay.bin;
  const home = overlay?.home ?? fileOverlay.home;
  const packageName = overlay?.packageName ?? fileOverlay.packageName ?? spec.packageName;
  return {
    version:
      overlay?.version ?? fileOverlay.version ?? STDIO_DEFAULTS.version,
    prefix:
      overlay?.prefix ??
      fileOverlay.prefix ??
      spec.defaultPrefix?.() ??
      defaultHarnessPrefix(spec.id),
    ...(bin?.trim() ? { bin: bin.trim() } : {}),
    ...(home?.trim() ? { home: home.trim() } : {}),
    ...(packageName?.trim() ? { packageName: packageName.trim() } : {}),
    npmBin: overlay?.npmBin ?? fileOverlay.npmBin ?? STDIO_DEFAULTS.npmBin,
    installTimeoutMs:
      overlay?.installTimeoutMs ??
      fileOverlay.installTimeoutMs ??
      STDIO_DEFAULTS.installTimeoutMs,
    updateIntervalHours:
      overlay?.updateIntervalHours ??
      fileOverlay.updateIntervalHours ??
      STDIO_DEFAULTS.updateIntervalHours,
    args: overlay?.args ?? fileOverlay.args ?? spec.args,
    binName: overlay?.binName ?? fileOverlay.binName ?? spec.binName,
    pathCandidates:
      overlay?.pathCandidates ??
      fileOverlay.pathCandidates ??
      spec.pathCandidates,
    requireApiKey:
      overlay?.requireApiKey ??
      fileOverlay.requireApiKey ??
      spec.requireApiKey,
    modes: {
      ...spec.modes,
      ...fileOverlay.modes,
      ...overlay?.modes,
    },
  };
}
