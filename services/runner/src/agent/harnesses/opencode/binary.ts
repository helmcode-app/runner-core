/**
 * OpenCode binary install path helpers (managed ACP harness).
 */

import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { OpenCodeHarnessSettings } from "./settings.js";

export function resolveOpenCodeBinaryPath(
  settings: OpenCodeHarnessSettings,
): string {
  if (settings.bin?.trim()) {
    return settings.bin.trim();
  }
  return path.join(settings.prefix, "bin", "opencode");
}

export function openCodePackageSpec(
  version: string,
  packageName = "opencode-ai",
): string {
  const v = version.trim() || "latest";
  return `${packageName}@${v}`;
}

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
