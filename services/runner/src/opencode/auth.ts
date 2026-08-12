/**
 * Materialize OpenCode provider credentials for managed `opencode serve`.
 *
 * OpenCode reads API keys from:
 *   $HOME/.local/share/opencode/auth.json
 *
 * Shape (matches `/connect` / `opencode auth login` for type=api providers):
 *   { "<providerID>": { "type": "api", "key": "..." } }
 *
 * Go and Zen are separate providers (same account key may be used for both):
 *   OPENCODE_GO_API_KEY  → opencode-go
 *   OPENCODE_ZEN_API_KEY → opencode
 * At least one is required when OPENCODE_MANAGED=true.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

/** OpenCode Go subscription catalog (`opencode-go/<model>`). */
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";
/** OpenCode Zen pay-as-you-go catalog (`opencode/<model>`). */
export const OPENCODE_ZEN_PROVIDER_ID = "opencode";

export interface OpenCodeAuthEntry {
  type: "api";
  key: string;
}

export type OpenCodeAuthFile = Record<string, OpenCodeAuthEntry>;

export interface OpenCodeAuthProviderSlot {
  providerId: string;
  key: string;
}

/**
 * Providers enabled by env keys (order: Go then Zen).
 * Empty when neither OPENCODE_GO_API_KEY nor OPENCODE_ZEN_API_KEY is set.
 */
export function resolveOpenCodeAuthProviders(
  config: AppConfig,
): OpenCodeAuthProviderSlot[] {
  const slots: OpenCodeAuthProviderSlot[] = [];
  const go = config.OPENCODE_GO_API_KEY?.trim();
  const zen = config.OPENCODE_ZEN_API_KEY?.trim();
  if (go) {
    slots.push({ providerId: OPENCODE_GO_PROVIDER_ID, key: go });
  }
  if (zen) {
    slots.push({ providerId: OPENCODE_ZEN_PROVIDER_ID, key: zen });
  }
  return slots;
}

/** Provider ids we materialize / should expose in the model catalog. */
export function enabledOpenCodeProviderIds(config: AppConfig): string[] {
  return resolveOpenCodeAuthProviders(config).map((s) => s.providerId);
}

/** Build auth.json from explicit provider slots. */
export function buildOpenCodeAuthFile(
  slots: OpenCodeAuthProviderSlot[],
): OpenCodeAuthFile {
  if (slots.length === 0) {
    throw new Error(
      "At least one of OPENCODE_GO_API_KEY or OPENCODE_ZEN_API_KEY is required",
    );
  }
  const file: OpenCodeAuthFile = {};
  for (const slot of slots) {
    const id = slot.providerId.trim();
    const key = slot.key.trim();
    if (!id) throw new Error("OpenCode provider id is empty");
    if (!key) throw new Error(`OpenCode API key for ${id} is empty`);
    file[id] = { type: "api", key };
  }
  return file;
}

export function serializeOpenCodeAuthFile(file: OpenCodeAuthFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Resolve OpenCode "home" for auth/config (not the npm install prefix). */
export function resolveOpenCodeHome(config: AppConfig): string {
  const explicit = config.OPENCODE_HOME?.trim();
  if (explicit) return explicit;
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (envHome) return envHome;
  return os.homedir();
}

/** `$HOME/.local/share/opencode/auth.json` */
export function resolveOpenCodeAuthPath(home: string): string {
  return path.join(home, ".local", "share", "opencode", "auth.json");
}

/**
 * Write auth.json from OPENCODE_GO_API_KEY / OPENCODE_ZEN_API_KEY before serve.
 * Throws if managed mode has no keys (local and prod both require at least one).
 */
export async function materializeOpenCodeAuth(
  config: AppConfig,
  logger?: Logger,
): Promise<{ authPath: string; providerIds: string[] }> {
  const slots = resolveOpenCodeAuthProviders(config);
  if (slots.length === 0) {
    throw new Error(
      "OPENCODE_GO_API_KEY and/or OPENCODE_ZEN_API_KEY is required when OPENCODE_MANAGED=true " +
        "(OpenCode dashboard keys — not a host mount)",
    );
  }

  const home = resolveOpenCodeHome(config);
  const authPath = resolveOpenCodeAuthPath(home);
  const file = buildOpenCodeAuthFile(slots);
  const body = serializeOpenCodeAuthFile(file);

  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, body, { encoding: "utf8", mode: 0o600 });

  const providerIds = slots.map((s) => s.providerId);
  logger?.info("opencode auth materialized", {
    authPath,
    providerIds,
    // never log keys
  });

  return { authPath, providerIds };
}
