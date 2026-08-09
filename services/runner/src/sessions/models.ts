/**
 * Flatten OpenCode GET /provider into Helm model picker options.
 * Only providers listed in `connected` (have credentials) are included.
 */

export interface SessionModelOption {
  /** `providerID/modelID` wire id for prompt body. */
  id: string;
  title: string;
  provider: string;
}

export interface SessionModelsResponse {
  models: SessionModelOption[];
  /** Preferred default when set (e.g. opencode/big-pickle). */
  default?: string;
  connected: string[];
}

export function mapProviderCatalog(raw: unknown): SessionModelsResponse {
  const o = asRecord(raw);
  const connected = toStringArray(o.connected);
  const connectedSet = new Set(connected.map((c) => c.toLowerCase()));

  const all = Array.isArray(o.all) ? o.all : [];
  const models: SessionModelOption[] = [];

  for (const item of all) {
    const p = asRecord(item);
    const providerID = firstString(p, ["id", "providerID"]);
    if (!providerID) continue;
    // If connected is empty (older OpenCode), include everything; else filter.
    if (connectedSet.size > 0 && !connectedSet.has(providerID.toLowerCase())) {
      continue;
    }
    const providerName = firstString(p, ["name"]) ?? providerID;
    const modelMap = p.models;
    if (!modelMap || typeof modelMap !== "object" || Array.isArray(modelMap)) {
      continue;
    }
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

  // Prefer OpenCode free defaults when present among connected.
  const preferred =
    models.find((m) => m.id === "opencode/big-pickle")?.id ??
    models.find((m) => m.id.startsWith("opencode/"))?.id ??
    models[0]?.id;

  const defaults = asRecord(o.default);
  let fromDefault: string | undefined;
  for (const [pid, mid] of Object.entries(defaults)) {
    if (typeof mid === "string" && mid && connectedSet.has(pid.toLowerCase())) {
      const id = mid.includes("/") ? mid : `${pid}/${mid}`;
      if (models.some((m) => m.id === id)) {
        fromDefault = id;
        break;
      }
    }
  }

  const chosenDefault = fromDefault ?? preferred;
  const out: SessionModelsResponse = {
    models,
    connected,
  };
  if (chosenDefault) {
    out.default = chosenDefault;
  }
  return out;
}

function humanizeModelId(id: string): string {
  return id
    .replace(/-free$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function firstString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}
