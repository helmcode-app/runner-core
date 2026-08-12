/**
 * OpenCode binary install path helpers (managed runtime).
 */

import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

const OPENCODE_PACKAGE = "opencode-ai";

export function resolveOpenCodeBinaryPath(config: AppConfig): string {
  if (config.OPENCODE_BIN?.trim()) {
    return config.OPENCODE_BIN.trim();
  }
  return path.join(config.OPENCODE_PREFIX, "bin", "opencode");
}

export function openCodePackageSpec(version: string): string {
  const v = version.trim() || "latest";
  return `${OPENCODE_PACKAGE}@${v}`;
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
