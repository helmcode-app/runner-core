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
import {
  stripModelDecoration,
  type ModelSelectEntry,
} from "./session-config.js";

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

export type DiscoveredModelInput = string | ModelSelectEntry;

function normalizeDiscovered(
  input: DiscoveredModelInput[],
): ModelSelectEntry[] {
  const out: ModelSelectEntry[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item === "string") {
      const id = stripModelDecoration(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const slash = id.lastIndexOf("/");
      out.push({
        id,
        wireValue: item.trim(),
        name: slash > 0 ? id.slice(slash + 1) : id,
        capabilityKeys: [],
      });
      continue;
    }
    const id = stripModelDecoration(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      ...item,
      id,
      name: stripModelDecoration(item.name) || id,
    });
  }
  return out;
}

export async function loadAgentModelsCatalog(
  config: AppConfig,
  opts?: {
    forceRefresh?: boolean;
    settings?: Partial<AgentSettings>;
    discoveredModels?: DiscoveredModelInput[];
    thinkLevels?: string[];
    thinkingLevels?: string[];
    contextLevels?: string[];
    context?: string;
    supportsFast?: boolean;
  },
): Promise<ModelsCatalog> {
  const extraModels = resolveAgentSettings(opts?.settings).extraModels;
  const discovered = normalizeDiscovered(opts?.discoveredModels ?? []);
  const thinkLevels = (opts?.thinkLevels ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const thinkingLevels = (opts?.thinkingLevels ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const contextLevels = (opts?.contextLevels ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  const context = opts?.context?.trim() || undefined;
  const supportsFast = opts?.supportsFast === true;
  const key = [
    catalogCacheKey(
      config,
      discovered.map((d) => d.id),
      extraModels,
    ),
    thinkLevels.join(","),
    thinkingLevels.join(","),
    contextLevels.join(","),
    context ?? "",
    supportsFast ? "1" : "0",
  ].join("|");

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

  const add = (
    id: string,
    connectedFlag: boolean,
    displayName?: string,
    opts?: { requireConnectedProvider?: boolean },
  ): void => {
    const trimmed = stripModelDecoration(id);
    if (!trimmed || seen.has(trimmed)) return;
    const slash = trimmed.indexOf("/");
    const provider =
      slash > 0 ? trimmed.slice(0, slash) : connected[0] ?? "unknown";
    // Fallback defaults must match the current harness — never keep a stale
    // `opencode-go/*` row while Cursor (or another vendor) is selected.
    // Harness-discovered ids are trusted as-is.
    if (
      opts?.requireConnectedProvider &&
      slash > 0 &&
      connected.length > 0 &&
      !connected.includes(provider)
    ) {
      return;
    }
    seen.add(trimmed);
    const fallbackName = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
    const name = stripModelDecoration(displayName ?? fallbackName) || fallbackName;
    models.push({
      id: trimmed,
      name,
      provider,
      connected: connectedFlag || connected.includes(provider),
    });
  };

  // Prefer harness-discovered ids. Only fall back to configured default /
  // overlay extras when discovery returned nothing.
  for (const entry of discovered) {
    add(entry.id, true, entry.name);
  }

  if (discovered.length === 0) {
    if (config.AGENT_DEFAULT_MODEL) {
      add(config.AGENT_DEFAULT_MODEL, true, undefined, {
        requireConnectedProvider: true,
      });
    }
    for (const part of extraModels) {
      add(part, true, undefined, { requireConnectedProvider: true });
    }
  }

  const configuredDefault = config.AGENT_DEFAULT_MODEL
    ? stripModelDecoration(config.AGENT_DEFAULT_MODEL)
    : undefined;
  const defaultModel =
    (configuredDefault && seen.has(configuredDefault)
      ? configuredDefault
      : undefined) ||
    models.find((m) => m.connected)?.id ||
    models[0]?.id;

  const catalog: ModelsCatalog = {
    models,
    connected,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(thinkLevels.length > 0 ? { thinkLevels } : {}),
    ...(thinkingLevels.length > 0 ? { thinkingLevels } : {}),
    ...(contextLevels.length > 0 ? { contextLevels } : {}),
    ...(context ? { context } : {}),
    ...(supportsFast ? { supportsFast: true } : { supportsFast: false }),
  };
  cached = { at: Date.now(), catalog, key };
  return catalog;
}

/** Test helper. */
export function clearModelsCatalogCache(): void {
  cached = null;
}
