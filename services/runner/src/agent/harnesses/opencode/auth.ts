/**
 * Materialize OpenCode provider credentials for managed `opencode acp`.
 *
 * OpenCode reads API keys from:
 *   $HOME/.local/share/opencode/auth.json
 *
 * One Helm provider id for the OpenCode harness:
 *   opencode-go → auth.json `opencode-go`
 *
 * Free Zen models (`opencode/beam-free`, …) are available through the same
 * OpenCode client once Go is connected — no separate Helm provider.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../../../config.js";
import type { Logger } from "../../../logger.js";

export interface OpenCodeHomeSettings {
  home?: string;
}

/** Canonical Helm AGENT_PROVIDER values for the OpenCode harness. */
export const AGENT_PROVIDER_IDS = ["opencode-go"] as const;

export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

/** Legacy ids accepted on read, always normalized to `opencode-go`. */
const LEGACY_AGENT_PROVIDER_ALIASES: Record<string, AgentProviderId> = {
  opencode: "opencode-go",
  "opencode-go-plus": "opencode-go",
  "opencode-zen": "opencode-go",
};

export function normalizeAgentProviderId(
  value: string,
): AgentProviderId | null {
  const trimmed = value.trim();
  if ((AGENT_PROVIDER_IDS as readonly string[]).includes(trimmed)) {
    return trimmed as AgentProviderId;
  }
  return LEGACY_AGENT_PROVIDER_ALIASES[trimmed] ?? null;
}

export function isAgentProviderId(value: string): value is AgentProviderId {
  return normalizeAgentProviderId(value) !== null;
}

/**
 * Map Helm AGENT_PROVIDER → OpenCode auth.json id.
 * Free `opencode/*` models share this OpenCode process; they are not a
 * separate auth slot.
 */
export const AGENT_PROVIDER_AUTH_IDS: Record<AgentProviderId, string> = {
  "opencode-go": "opencode-go",
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
 * Resolve the configured provider slot from AGENT_PROVIDER + AGENT_API_KEY.
 * Empty when neither is set.
 */
export function resolveOpenCodeAuthProviders(
  config: AppConfig,
): OpenCodeAuthProviderSlot[] {
  const raw = config.AGENT_PROVIDER;
  const key = config.AGENT_API_KEY?.trim();
  if (!raw && !key) return [];
  // Key alone is enough — OpenCode's only Helm provider is opencode-go.
  const provider = normalizeAgentProviderId(raw ?? "opencode-go");
  if (!provider) {
    throw new Error(`Unsupported AGENT_PROVIDER: ${raw}`);
  }
  if (!key) {
    throw new Error(
      `AGENT_API_KEY is required when AGENT_HARNESS=opencode`,
    );
  }
  return [{ providerId: AGENT_PROVIDER_AUTH_IDS[provider], key }];
}

/**
 * Provider ids exposed as "connected" in the models catalog.
 * Include both `opencode-go` and `opencode` so free Zen models remain selectable.
 */
export function enabledOpenCodeProviderIds(config: AppConfig): string[] {
  const slots = resolveOpenCodeAuthProviders(config);
  if (slots.length === 0) return [];
  return ["opencode-go", "opencode"];
}

/** Build auth.json from explicit provider slots. */
export function buildOpenCodeAuthFile(
  slots: OpenCodeAuthProviderSlot[],
): OpenCodeAuthFile {
  if (slots.length === 0) {
    throw new Error("AGENT_API_KEY is required for OpenCode auth.json");
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
  settings?: OpenCodeHomeSettings,
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
 * Write auth.json before spawning ACP.
 */
export async function materializeOpenCodeAuth(
  config: AppConfig,
  logger?: Logger,
  settings?: OpenCodeHomeSettings,
): Promise<{ authPath: string; providerIds: string[] }> {
  const slots = resolveOpenCodeAuthProviders(config);
  if (slots.length === 0) {
    throw new Error(
      "AGENT_API_KEY is required when AGENT_HARNESS=opencode",
    );
  }

  const home = resolveOpenCodeHome(settings);
  const authPath = resolveOpenCodeAuthPath(home);
  const file = buildOpenCodeAuthFile(slots);
  const body = serializeOpenCodeAuthFile(file);

  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, body, { encoding: "utf8", mode: 0o600 });

  const providerIds = enabledOpenCodeProviderIds(config);
  logger?.info("opencode auth materialized", {
    authPath,
    providerIds,
    agentProvider: config.AGENT_PROVIDER,
  });

  return { authPath, providerIds };
}
