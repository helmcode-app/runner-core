/**
 * Models catalog for ACP agent gateway.
 *
 * Prefer harness-advertised ids (ACP session `configOptions`). Fall back to
 * AGENT_DEFAULT_MODEL + extraModels when discovery has not run yet.
 */

import type { AppConfig } from "../config.js";
import type {
  SessionModel,
  SessionModelsResponse,
} from "../sessions/types.js";
import { connectedProviderIds } from "./harnesses/catalog.js";
import { resolveAgentSettings, type AgentSettings } from "./settings.js";

export type { SessionModel, SessionModelsResponse };
export type SessionModelInfo = SessionModel;
export type ModelsCatalog = SessionModelsResponse;

let cached: { at: number; catalog: ModelsCatalog; key: string } | null = null;
const CACHE_MS = 30_000;

function catalogCacheKey(
  config: AppConfig,
  discovered: string[],
  extraModels: string[],
): string {
  return [
    config.AGENT_HARNESS,
    config.AGENT_PROVIDER,
    config.AGENT_DEFAULT_MODEL,
    discovered.join(","),
    extraModels.join(","),
  ].join("|");
}

export async function loadAgentModelsCatalog(
  config: AppConfig,
  opts?: {
    forceRefresh?: boolean;
    settings?: Partial<AgentSettings>;
    discoveredModels?: string[];
  },
): Promise<ModelsCatalog> {
  const extraModels = resolveAgentSettings(opts?.settings).extraModels;
  const discovered = (opts?.discoveredModels ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const key = catalogCacheKey(config, discovered, extraModels);

  if (
    !opts?.forceRefresh &&
    cached &&
    cached.key === key &&
    Date.now() - cached.at < CACHE_MS
  ) {
    return cached.catalog;
  }

  const connected = connectedProviderIds(config);
  const models: SessionModel[] = [];
  const seen = new Set<string>();

  const add = (id: string, connectedFlag: boolean): void => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    const slash = trimmed.indexOf("/");
    const provider =
      slash > 0 ? trimmed.slice(0, slash) : connected[0] ?? "unknown";
    const name = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
    models.push({
      id: trimmed,
      name,
      provider,
      connected: connectedFlag || connected.includes(provider),
    });
  };

  if (config.AGENT_DEFAULT_MODEL) {
    add(config.AGENT_DEFAULT_MODEL, true);
  }

  for (const id of discovered) {
    add(id, true);
  }

  for (const part of extraModels) {
    add(part, true);
  }

  // Placeholders so UI can show something when only provider is configured.
  for (const provider of connected) {
    if (![...seen].some((id) => id.startsWith(`${provider}/`))) {
      add(`${provider}/default`, true);
    }
  }

  const defaultModel =
    config.AGENT_DEFAULT_MODEL?.trim() ||
    models.find((m) => m.connected)?.id ||
    models[0]?.id;

  const catalog: ModelsCatalog = {
    models,
    connected,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
  };
  cached = { at: Date.now(), catalog, key };
  return catalog;
}

/** Test helper. */
export function clearModelsCatalogCache(): void {
  cached = null;
}
