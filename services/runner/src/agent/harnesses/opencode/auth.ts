/**
 * Materialize OpenCode provider credentials for managed `opencode acp`.
 *
 * OpenCode reads API keys from:
 *   $HOME/.local/share/opencode/auth.json
 *
 * Configured via AGENT_PROVIDER + AGENT_API_KEY:
 *   opencode-go  → auth.json `opencode-go`  / models `opencode-go/<model>`
 *   opencode-zen → auth.json `opencode`     / models `opencode/<model>`
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../../../config.js";
import type { Logger } from "../../../logger.js";
import type { OpenCodeHarnessSettings } from "./settings.js";

/** Helm AGENT_PROVIDER values supported today. */
export type AgentProviderId = "opencode-go" | "opencode-zen";

/**
 * Map Helm AGENT_PROVIDER → OpenCode auth.json / catalog provider id.
 * Extend this table when adding providers.
 */
export const AGENT_PROVIDER_AUTH_IDS: Record<AgentProviderId, string> = {
  "opencode-go": "opencode-go",
  "opencode-zen": "opencode",
};

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
 * Resolve the single configured provider slot from AGENT_PROVIDER + AGENT_API_KEY.
 * Empty when either is unset (external / unconfigured managed will fail later).
 */
export function resolveOpenCodeAuthProviders(
  config: AppConfig,
): OpenCodeAuthProviderSlot[] {
  const provider = config.AGENT_PROVIDER;
  const key = config.AGENT_API_KEY?.trim();
  if (!provider && !key) return [];
  if (!provider) {
    throw new Error(
      "AGENT_PROVIDER is required when AGENT_API_KEY is set (e.g. opencode-go, opencode-zen)",
    );
  }
  if (!key) {
    throw new Error(
      `AGENT_API_KEY is required when AGENT_PROVIDER=${provider}`,
    );
  }
  const authId = AGENT_PROVIDER_AUTH_IDS[provider];
  if (!authId) {
    throw new Error(`Unsupported AGENT_PROVIDER: ${provider}`);
  }
  return [{ providerId: authId, key }];
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
    throw new Error("AGENT_PROVIDER and AGENT_API_KEY are required");
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
export function resolveOpenCodeHome(
  settings?: Pick<OpenCodeHarnessSettings, "home">,
): string {
  const explicit = settings?.home?.trim();
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
 * Write auth.json from AGENT_PROVIDER + AGENT_API_KEY before spawning ACP.
 * Throws if managed mode has no credentials.
 */
export async function materializeOpenCodeAuth(
  config: AppConfig,
  logger?: Logger,
  settings?: Pick<OpenCodeHarnessSettings, "home">,
): Promise<{ authPath: string; providerIds: string[] }> {
  const slots = resolveOpenCodeAuthProviders(config);
  if (slots.length === 0) {
    throw new Error(
      "AGENT_PROVIDER and AGENT_API_KEY are required when SESSIONS_ENABLED=true " +
        "(e.g. AGENT_PROVIDER=opencode-go)",
    );
  }

  const home = resolveOpenCodeHome(settings);
  const authPath = resolveOpenCodeAuthPath(home);
  const file = buildOpenCodeAuthFile(slots);
  const body = serializeOpenCodeAuthFile(file);

  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, body, { encoding: "utf8", mode: 0o600 });

  const providerIds = slots.map((s) => s.providerId);
  logger?.info("opencode auth materialized", {
    authPath,
    providerIds,
    agentProvider: config.AGENT_PROVIDER,
  });

  return { authPath, providerIds };
}
