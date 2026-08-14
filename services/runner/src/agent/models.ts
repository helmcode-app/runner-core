/**
 * Models catalog for ACP agent gateway.
 *
 * Until harness provider discovery is wired, advertise configured
 * AGENT_DEFAULT_MODEL + extraModels + the connected provider for this harness.
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

let cached: { at: number; catalog: ModelsCatalog } | null = null;
const CACHE_MS = 30_000;

export async function loadAgentModelsCatalog(
  config: AppConfig,
  opts?: { forceRefresh?: boolean; settings?: Partial<AgentSettings> },
): Promise<ModelsCatalog> {
  if (
    !opts?.forceRefresh &&
    cached &&
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

  const extraModels = resolveAgentSettings(opts?.settings).extraModels;
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
  cached = { at: Date.now(), catalog };
  return catalog;
}

/** Test helper. */
export function clearModelsCatalogCache(): void {
  cached = null;
}
