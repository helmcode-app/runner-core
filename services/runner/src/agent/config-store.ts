/**
 * Durable agent selection under `$WORKSPACES_PATH/.setup/agent.json`.
 *
 * Product path: client PUT → file → runtime controller applies (spawn ACP).
 * Env (`SESSIONS_ENABLED` / `AGENT_*`) remains a bootstrap override when no
 * file exists (CI / compose). Once a file is written, it is the source of truth.
 */

import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { adoptWorkspaceOwner, defaultSetupDir } from "../setup/store.js";
import {
  AGENT_HARNESS_IDS,
  connectedProviderIds,
  type AgentHarnessId,
  harnessNeedsProvider,
} from "./harnesses/catalog.js";
import {
  normalizeAgentProviderId,
  type AgentProviderId,
} from "./harnesses/opencode/auth.js";

export const AGENT_CONFIG_VERSION = 1 as const;

export type AgentConfigSource = "file" | "env" | "none";

export interface PersistedAgentConfig {
  version: typeof AGENT_CONFIG_VERSION;
  enabled: boolean;
  harness: AgentHarnessId;
  /** Required when harness needs a provider (OpenCode) and enabled. */
  provider?: AgentProviderId;
  apiKey?: string;
  defaultModel?: string;
  updatedAt: string;
}

export interface AgentConfigUpdate {
  enabled: boolean;
  harness: AgentHarnessId;
  provider?: AgentProviderId;
  /** Omit to keep the previous key; set string (incl. empty) to replace. */
  apiKey?: string;
  defaultModel?: string | null;
}

export function defaultAgentConfigPath(workspacesPath: string): string {
  return path.join(defaultSetupDir(workspacesPath), "agent.json");
}

export function parsePersistedAgentConfig(
  input: unknown,
): PersistedAgentConfig | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (row.version !== AGENT_CONFIG_VERSION) return null;
  if (typeof row.enabled !== "boolean") return null;
  if (
    typeof row.harness !== "string" ||
    !(AGENT_HARNESS_IDS as readonly string[]).includes(row.harness)
  ) {
    return null;
  }
  if (typeof row.updatedAt !== "string" || !row.updatedAt) return null;

  const out: PersistedAgentConfig = {
    version: AGENT_CONFIG_VERSION,
    enabled: row.enabled,
    harness: row.harness as AgentHarnessId,
    updatedAt: row.updatedAt,
  };
  if (row.provider !== undefined) {
    if (typeof row.provider !== "string") return null;
    const provider = normalizeAgentProviderId(row.provider);
    if (!provider) return null;
    out.provider = provider;
  }
  if (row.apiKey !== undefined) {
    if (typeof row.apiKey !== "string") return null;
    const key = row.apiKey.trim();
    if (key) out.apiKey = key;
  }
  if (row.defaultModel !== undefined) {
    if (typeof row.defaultModel !== "string") return null;
    const model = row.defaultModel.trim();
    if (model) out.defaultModel = model;
  }
  return out;
}

export async function loadPersistedAgentConfig(
  filePath: string,
): Promise<PersistedAgentConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const config = parsePersistedAgentConfig(parsed);
    return config ? sanitizePersistedAgentConfig(config) : null;
  } catch {
    return null;
  }
}

export async function savePersistedAgentConfig(
  filePath: string,
  config: PersistedAgentConfig,
): Promise<void> {
  const sanitized = sanitizePersistedAgentConfig(config);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(sanitized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  await rm(tmp, { force: true }).catch(() => undefined);
  await adoptWorkspaceOwner(dir, filePath);
}

/** Build a file-shaped config from env when no agent.json exists. */
export function agentConfigFromEnv(config: AppConfig): PersistedAgentConfig | null {
  if (!config.SESSIONS_ENABLED) return null;
  const out: PersistedAgentConfig = {
    version: AGENT_CONFIG_VERSION,
    enabled: true,
    harness: config.AGENT_HARNESS,
    updatedAt: new Date(0).toISOString(),
  };
  if (config.AGENT_PROVIDER) out.provider = config.AGENT_PROVIDER;
  if (config.AGENT_API_KEY?.trim()) out.apiKey = config.AGENT_API_KEY.trim();
  if (config.AGENT_DEFAULT_MODEL?.trim()) {
    out.defaultModel = config.AGENT_DEFAULT_MODEL.trim();
  }
  return out;
}

export function mergeAgentConfigUpdate(
  previous: PersistedAgentConfig | null,
  update: AgentConfigUpdate,
): PersistedAgentConfig {
  const next: PersistedAgentConfig = {
    version: AGENT_CONFIG_VERSION,
    enabled: update.enabled,
    harness: update.harness,
    updatedAt: new Date().toISOString(),
  };

  if (update.provider !== undefined) {
    const provider = normalizeAgentProviderId(update.provider);
    if (provider) next.provider = provider;
  } else if (
    previous?.provider &&
    previous.harness === update.harness
  ) {
    const provider = normalizeAgentProviderId(previous.provider);
    if (provider) next.provider = provider;
  }

  if (update.apiKey !== undefined) {
    const key = update.apiKey.trim();
    if (key) next.apiKey = key;
  } else if (previous?.apiKey) {
    next.apiKey = previous.apiKey;
  }

  if (update.defaultModel === null) {
    // clear
  } else if (typeof update.defaultModel === "string") {
    const model = update.defaultModel.trim();
    if (model) next.defaultModel = model;
  } else if (
    previous?.defaultModel &&
    previous.harness === update.harness
  ) {
    // Keep default only within the same harness — switching Cursor←→OpenCode
    // must not leak `opencode-go/glm-5.1` into the new catalog.
    next.defaultModel = previous.defaultModel;
  }

  return next;
}

export function validateAgentConfig(config: PersistedAgentConfig): string | null {
  if (!config.enabled) return null;
  if (harnessNeedsProvider(config.harness) && !config.provider) {
    return `provider is required when harness=${config.harness}`;
  }
  if (config.harness === "opencode" && !config.apiKey?.trim()) {
    return "apiKey is required when harness=opencode (connect OpenCode Go; free opencode/* models still work)";
  }
  return null;
}

/**
 * Drop a defaultModel that cannot belong to the selected harness
 * (e.g. `opencode-go/glm-5.1` after switching to Cursor).
 */
export function sanitizePersistedAgentConfig(
  config: PersistedAgentConfig,
): PersistedAgentConfig {
  const model = config.defaultModel?.trim();
  if (!model) return config;
  const slash = model.indexOf("/");
  if (slash <= 0) {
    // Bare ids (Cursor-style) are fine for any harness.
    return config;
  }
  const provider = model.slice(0, slash);
  const connected = connectedProviderIds({
    AGENT_HARNESS: config.harness,
    AGENT_PROVIDER: config.provider,
    AGENT_API_KEY: config.apiKey ?? "x",
  } as AppConfig);
  if (connected.includes(provider)) return config;
  const { defaultModel: _drop, ...rest } = config;
  return rest;
}

/** Overlay agent selection onto the process AppConfig for harness spawn. */
export function effectiveAppConfig(
  base: AppConfig,
  agent: PersistedAgentConfig | null,
): AppConfig {
  if (!agent?.enabled) {
    return { ...base, SESSIONS_ENABLED: false };
  }
  const sanitized = sanitizePersistedAgentConfig(agent);
  return {
    ...base,
    SESSIONS_ENABLED: true,
    AGENT_HARNESS: sanitized.harness,
    AGENT_PROVIDER: sanitized.provider,
    AGENT_API_KEY: sanitized.apiKey,
    AGENT_DEFAULT_MODEL: sanitized.defaultModel,
  };
}

export function redactApiKey(apiKey: string | undefined): {
  hasApiKey: boolean;
  apiKeyHint?: string;
} {
  const key = apiKey?.trim();
  if (!key) return { hasApiKey: false };
  if (key.length <= 4) return { hasApiKey: true, apiKeyHint: "••••" };
  return { hasApiKey: true, apiKeyHint: `••••${key.slice(-4)}` };
}
