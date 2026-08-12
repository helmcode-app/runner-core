/**
 * Flatten OpenCode GET /provider into Helm model picker options.
 *
 * Prefer an explicit `allowProviders` allow-list (from OPENCODE_GO/ZEN_API_KEY)
 * so OpenCode cannot surface Zen when only Go is configured (or vice versa).
 * When no allow-list is given, fall back to OpenCode `connected` (external mode).
 */

import type { AppConfig } from "../config.js";
import { enabledOpenCodeProviderIds } from "../opencode/auth.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { asRecord, firstString } from "./map-util.js";
import {
  clearProviderCatalogCache,
  getCachedProviderCatalog,
  setCachedProviderCatalog,
} from "./models-cache.js";

export {
  clearProviderCatalogCache,
  getCachedProviderCatalog,
  setCachedProviderCatalog,
} from "./models-cache.js";

export interface SessionModelOption {
  /** `providerID/modelID` wire id for prompt body. */
  id: string;
  title: string;
  provider: string;
}

export interface SessionModelsResponse {
  models: SessionModelOption[];
  /** Preferred default when set (e.g. opencode-go/… or opencode/big-pickle). */
  default?: string;
  /** Provider ids included in this response. */
  connected: string[];
}

export interface MapProviderCatalogOptions {
  /**
   * When non-empty, only these provider ids are included (case-insensitive).
   * Managed runner should pass keys from OPENCODE_GO_API_KEY / OPENCODE_ZEN_API_KEY.
   */
  allowProviders?: string[];
}

/**
 * Load catalog for `/v1/sessions/models`: cache → OpenCode `/provider` → filter.
 */
export async function loadSessionModelsCatalog(
  client: OpenCodeClient,
  config: AppConfig,
  opts: { forceRefresh?: boolean } = {},
): Promise<SessionModelsResponse> {
  if (opts.forceRefresh) {
    clearProviderCatalogCache();
  } else {
    const cached = getCachedProviderCatalog();
    if (cached) return cached;
  }

  const raw = await client.listProviders();
  // Managed keys pin which catalogs we expose (Go vs Zen). External mode
  // with no keys falls back to OpenCode `connected` only.
  const allowProviders = enabledOpenCodeProviderIds(config);
  const mapped = mapProviderCatalog(raw, {
    ...(allowProviders.length > 0 ? { allowProviders } : {}),
  });
  setCachedProviderCatalog(mapped);
  return mapped;
}

export function mapProviderCatalog(
  raw: unknown,
  opts: MapProviderCatalogOptions = {},
): SessionModelsResponse {
  const o = asRecord(raw);
  const upstreamConnected = toStringArray(o.connected);
  const upstreamSet = new Set(upstreamConnected.map((c) => c.toLowerCase()));

  const allowRaw = (opts.allowProviders ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const allowSet =
    allowRaw.length > 0
      ? new Set(allowRaw.map((p) => p.toLowerCase()))
      : null;

  const all = Array.isArray(o.all) ? o.all : [];
  const models: SessionModelOption[] = [];
  const includedProviders: string[] = [];

  for (const item of all) {
    const p = asRecord(item);
    const providerID = firstString(p, ["id", "providerID"]);
    if (!providerID) continue;
    const pid = providerID.toLowerCase();

    if (allowSet) {
      if (!allowSet.has(pid)) continue;
    } else if (upstreamSet.size > 0 && !upstreamSet.has(pid)) {
      // External / no allow-list: trust OpenCode connected when present.
      continue;
    }

    const providerName = firstString(p, ["name"]) ?? providerID;
    const modelMap = p.models;
    if (!modelMap || typeof modelMap !== "object" || Array.isArray(modelMap)) {
      continue;
    }
    includedProviders.push(providerID);
    for (const [modelID, meta] of Object.entries(
      modelMap as Record<string, unknown>,
    )) {
      if (!modelID) continue;
      const m = asRecord(meta);
      const title =
        firstString(m, ["name", "title", "id"]) ?? humanizeModelId(modelID);
      models.push({
        id: `${providerID}/${modelID}`,
        title,
        provider: providerName,
      });
    }
  }

  models.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.title.localeCompare(b.title);
  });

  const preferred = pickPreferredDefault(models);
  const fromDefault = pickFromOpenCodeDefaults(
    asRecord(o.default),
    models,
    allowSet ?? upstreamSet,
  );

  const chosenDefault = fromDefault ?? preferred;
  const connected = resolveConnectedList(
    allowSet,
    allowRaw,
    includedProviders,
    upstreamConnected,
  );

  const out: SessionModelsResponse = {
    models,
    connected,
  };
  if (chosenDefault) {
    out.default = chosenDefault;
  }
  return out;
}

function pickPreferredDefault(models: SessionModelOption[]): string | undefined {
  // Prefer Go subscription defaults, then Zen free, then first available.
  return (
    models.find((m) => m.id.startsWith("opencode-go/"))?.id ??
    models.find((m) => m.id === "opencode/big-pickle")?.id ??
    models.find((m) => m.id.startsWith("opencode/"))?.id ??
    models[0]?.id
  );
}

function pickFromOpenCodeDefaults(
  defaults: Record<string, unknown>,
  models: SessionModelOption[],
  allowed: Set<string>,
): string | undefined {
  for (const [pid, mid] of Object.entries(defaults)) {
    if (typeof mid !== "string" || !mid) continue;
    if (allowed.size > 0 && !allowed.has(pid.toLowerCase())) continue;
    const id = mid.includes("/") ? mid : `${pid}/${mid}`;
    if (models.some((m) => m.id === id)) return id;
  }
  return undefined;
}

function resolveConnectedList(
  allowSet: Set<string> | null,
  allowRaw: string[],
  includedProviders: string[],
  upstreamConnected: string[],
): string[] {
  if (allowSet && allowRaw.length > 0) {
    return includedProviders;
  }
  if (upstreamConnected.length > 0) {
    return upstreamConnected.filter((c) =>
      includedProviders.some((p) => p.toLowerCase() === c.toLowerCase()),
    );
  }
  return includedProviders;
}

function humanizeModelId(id: string): string {
  return id
    .replace(/-free$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}
