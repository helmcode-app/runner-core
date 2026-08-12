/**
 * Short TTL cache for GET /v1/sessions/models.
 * OpenCode `/provider` can be large; reconnect storms and Settings refreshes
 * should not re-hit it every time.
 */

import type { SessionModelsResponse } from "./models.js";

const CATALOG_TTL_MS = 60_000;
let catalogCache: { at: number; value: SessionModelsResponse } | null = null;

export function getCachedProviderCatalog(): SessionModelsResponse | null {
  if (!catalogCache) return null;
  if (Date.now() - catalogCache.at > CATALOG_TTL_MS) {
    catalogCache = null;
    return null;
  }
  return catalogCache.value;
}

export function setCachedProviderCatalog(value: SessionModelsResponse): void {
  catalogCache = { at: Date.now(), value };
}

export function clearProviderCatalogCache(): void {
  catalogCache = null;
}
