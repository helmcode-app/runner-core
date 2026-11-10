/**
 * Map Helm prompt knobs (thinkLevel / fast / context) onto ACP
 * session/set_config_option, and discover picker lists from configOptions.
 */

export type HelmConfigOption =
  | {
      id: string;
      type: "select";
      name: string;
      values: string[];
      /** Display labels keyed by wire value (when the harness sends `name`). */
      valueNames?: Record<string, string>;
      currentValue?: string;
      category?: string;
    }
  | {
      id: string;
      type: "boolean";
      name: string;
      currentValue?: boolean;
      category?: string;
    };

export type SetConfigPayload =
  | { configId: string; type: "boolean"; value: boolean }
  | { configId: string; value: string };

export type ModelSelectEntry = {
  /** Clean catalog id (brackets / params stripped). */
  id: string;
  /** Original select value for set_config_option. */
  wireValue: string;
  /** Clean display name (no capability tag list). */
  name: string;
  /** Capability keys advertised in `[context,effort/fast,…]` tags. */
  capabilityKeys: string[];
};

type SelectEntry = { value: string; name?: string };

function flattenSelectEntries(options: unknown): SelectEntry[] {
  if (!Array.isArray(options)) return [];
  const out: SelectEntry[] = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value === "string" && rec.value.length > 0) {
      out.push({
        value: rec.value,
        ...(typeof rec.name === "string" && rec.name.length > 0
          ? { name: rec.name }
          : {}),
      });
    }
    if (Array.isArray(rec.options)) {
      out.push(...flattenSelectEntries(rec.options));
    }
  }
  return out;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Strip Cursor-style `[…]` decorations from model ids / names. */
export function stripModelDecoration(raw: string): string {
  const trimmed = raw.trim();
  const bracket = trimmed.indexOf("[");
  if (bracket <= 0) return trimmed;
  return trimmed.slice(0, bracket).trim();
}

/**
 * Parse capability keys from decorations like:
 * - `Name[context,reasoning_effort/effort/fast,thinking]`
 * - `id[context=1m,effort=high,fast=true]`
 */
export function parseModelCapabilityKeys(raw: string): string[] {
  const match = raw.match(/\[([^\]]*)\]/);
  if (!match?.[1]) return [];
  const keys = new Set<string>();
  for (const part of match[1].split(",")) {
    const token = part.trim();
    if (!token) continue;
    const keyPart = token.split("=")[0]?.trim() ?? "";
    if (!keyPart) continue;
    for (const alt of keyPart.split("/")) {
      const key = alt.trim().toLowerCase();
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

export function parseConfigOptions(raw: unknown): HelmConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: HelmConfigOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) continue;
    const name =
      typeof rec.name === "string" && rec.name.length > 0 ? rec.name : rec.id;
    const category =
      typeof rec.category === "string" && rec.category.length > 0
        ? rec.category
        : undefined;
    if (rec.type === "boolean") {
      out.push({
        id: rec.id,
        type: "boolean",
        name,
        ...(typeof rec.currentValue === "boolean"
          ? { currentValue: rec.currentValue }
          : {}),
        ...(category !== undefined ? { category } : {}),
      });
      continue;
    }
    const entries = flattenSelectEntries(rec.options);
    const values = entries.map((e) => e.value);
    const valueNames: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.name) valueNames[entry.value] = entry.name;
    }
    out.push({
      id: rec.id,
      type: "select",
      name,
      values,
      ...(Object.keys(valueNames).length > 0 ? { valueNames } : {}),
      ...(typeof rec.currentValue === "string"
        ? { currentValue: rec.currentValue }
        : {}),
      ...(category !== undefined ? { category } : {}),
    });
  }
  return out;
}

function optionLabel(option: HelmConfigOption): string {
  return `${option.id} ${option.name} ${option.category ?? ""}`;
}

function findByCategoryOrLabel(
  options: HelmConfigOption[],
  category: string,
  labelRe: RegExp,
): HelmConfigOption | undefined {
  return (
    options.find((o) => o.category === category) ??
    options.find((o) => labelRe.test(optionLabel(o)))
  );
}

function matchSelectValue(
  values: string[],
  wanted: string,
  aliases: string[],
): string | undefined {
  const exact = values.find((v) => v === wanted);
  if (exact) return exact;
  const targets = new Set([wanted, ...aliases].map(normalize));
  return values.find((v) => targets.has(normalize(v)));
}

export const PRODUCT_THINK_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

const THINK_ALIASES: Record<string, string[]> = {
  low: ["minimal", "min"],
  medium: ["default", "normal"],
  high: [],
  xhigh: ["extra-high", "extrahigh", "x-high", "max", "maximum"],
};

/** On/off thinking toggle (Cursor Claude) — not an effort ladder. */
function isThinkingToggleOption(option: HelmConfigOption): boolean {
  if (!/^(thinking|think)$/i.test(option.id) && !/^thinking$/i.test(option.name)) {
    return false;
  }
  if (option.type === "boolean") return true;
  const normalized = option.values.map(normalize);
  return (
    normalized.length > 0 &&
    normalized.every((v) =>
      ["true", "false", "on", "off", "1", "0"].includes(v),
    )
  );
}

function findEffortOption(
  options: HelmConfigOption[],
): Extract<HelmConfigOption, { type: "select" }> | undefined {
  const candidates = options.filter(
    (o): o is Extract<HelmConfigOption, { type: "select" }> =>
      o.type === "select" && !isThinkingToggleOption(o),
  );
  const byId = candidates.find((o) =>
    /^(effort|reasoning|reasoning_effort|thought_level)$/i.test(o.id),
  );
  if (byId) return byId;
  const byCategory = candidates.find((o) => o.category === "thought_level");
  if (byCategory) return byCategory;
  return candidates.find((o) => /effort|reason|thought/i.test(optionLabel(o)));
}

function findThinkingToggle(
  options: HelmConfigOption[],
): HelmConfigOption | undefined {
  return options.find(isThinkingToggleOption);
}

function findContextOption(
  options: HelmConfigOption[],
): Extract<HelmConfigOption, { type: "select" }> | undefined {
  const option =
    options.find((o) => /^context(_size|_window)?$/i.test(o.id)) ??
    findByCategoryOrLabel(options, "model_config", /\bcontext\b/i);
  if (!option || option.type !== "select") return undefined;
  if (/fast|speed|turbo|effort|reason|think/i.test(option.id)) return undefined;
  return option;
}

export function thinkLevelSetConfig(
  options: HelmConfigOption[],
  thinkLevel: string,
): SetConfigPayload | undefined {
  const wanted = thinkLevel.trim();
  if (!wanted) return undefined;
  const option = findEffortOption(options);
  if (!option) return undefined;
  const aliases = THINK_ALIASES[normalize(wanted)] ?? [];
  const value = matchSelectValue(option.values, wanted, aliases);
  if (!value) return undefined;
  return { configId: option.id, value };
}

/**
 * Effort / reasoning levels the harness accepts (for the Think picker).
 * Skips boolean-style `thinking` toggles so Claude Off/On does not hide the ladder.
 */
export function thinkLevelsFromConfigOptions(
  options: HelmConfigOption[],
): string[] {
  const option = findEffortOption(options);
  if (!option || option.values.length === 0) return [];
  const mapped = PRODUCT_THINK_LEVELS.filter(
    (level) => thinkLevelSetConfig(options, level) !== undefined,
  );
  if (mapped.length > 0) return [...mapped];
  return uniqueNonEmpty(option.values.map(stripModelDecoration));
}

/** Thinking on/off values when the harness advertises a thinking toggle. */
export function thinkingLevelsFromConfigOptions(
  options: HelmConfigOption[],
): string[] {
  const option = findThinkingToggle(options);
  if (!option) return [];
  if (option.type === "boolean") return ["false", "true"];
  return uniqueNonEmpty(option.values);
}

export function thinkingSetConfig(
  options: HelmConfigOption[],
  thinking: string | boolean,
): SetConfigPayload | undefined {
  const option = findThinkingToggle(options);
  if (!option) return undefined;
  const wanted =
    typeof thinking === "boolean"
      ? thinking
        ? "true"
        : "false"
      : thinking.trim();
  if (!wanted) return undefined;
  if (option.type === "boolean") {
    const on = /^(true|on|1|yes)$/i.test(wanted);
    return { configId: option.id, type: "boolean", value: on };
  }
  const value = matchSelectValue(option.values, wanted, [
    wanted === "true" ? "on" : "off",
    wanted === "false" ? "off" : "on",
  ]);
  if (!value) return undefined;
  return { configId: option.id, value };
}

export function contextLevelsFromConfigOptions(
  options: HelmConfigOption[],
): string[] {
  const option = findContextOption(options);
  if (!option) return [];
  return uniqueNonEmpty(option.values.map(stripModelDecoration));
}

/** Current context select value when advertised. */
export function currentContextFromConfigOptions(
  options: HelmConfigOption[],
): string | undefined {
  const option = findContextOption(options);
  if (!option?.currentValue) return undefined;
  return stripModelDecoration(option.currentValue);
}

/**
 * Parse harness context labels (`200k`, `1m`, `272k`) into token counts for the
 * composer usage meter.
 */
export function parseContextTokens(raw: string): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const suffix = match[2];
  if (suffix === "k") return Math.round(amount * 1_000);
  if (suffix === "m") return Math.round(amount * 1_000_000);
  if (suffix === "b") return Math.round(amount * 1_000_000_000);
  return Math.round(amount);
}

export function contextSetConfig(
  options: HelmConfigOption[],
  context: string,
): SetConfigPayload | undefined {
  const wanted = context.trim();
  if (!wanted) return undefined;
  const option = findContextOption(options);
  if (!option) return undefined;
  const value =
    matchSelectValue(option.values, wanted, []) ??
    option.values.find(
      (v) => normalize(stripModelDecoration(v)) === normalize(wanted),
    );
  if (!value) return undefined;
  return { configId: option.id, value };
}

/** True when ACP advertises a fast / turbo boolean or select. */
export function supportsFastFromConfigOptions(
  options: HelmConfigOption[],
): boolean {
  return (
    fastSetConfig(options, true) !== undefined ||
    fastSetConfig(options, false) !== undefined
  );
}

export function fastLevelsFromConfigOptions(
  options: HelmConfigOption[],
): string[] {
  if (!supportsFastFromConfigOptions(options)) return [];
  const option =
    options.find((o) => /fast/i.test(optionLabel(o))) ??
    options.find(
      (o) =>
        o.category === "model_config" && /speed|turbo/i.test(optionLabel(o)),
    );
  if (!option) return [];
  if (option.type === "boolean") return ["false", "true"];
  return uniqueNonEmpty(option.values);
}

function findModelOption(options: HelmConfigOption[]): HelmConfigOption | undefined {
  return (
    options.find((o) => o.category === "model" || o.id === "model") ??
    options.find((o) => /^model$/i.test(o.name))
  );
}

function displayNameForModel(
  wireValue: string,
  label: string | undefined,
): string {
  const fromLabel = label ? stripModelDecoration(label) : "";
  if (fromLabel && !looksLikeCapabilityTagList(fromLabel)) {
    // Prefer "Provider / Model" → Model when label is `provider/name`.
    const slash = fromLabel.lastIndexOf("/");
    if (slash > 0 && slash < fromLabel.length - 1) {
      return fromLabel.slice(slash + 1).trim() || fromLabel;
    }
    return fromLabel;
  }
  const cleaned = stripModelDecoration(wireValue);
  const slash = cleaned.lastIndexOf("/");
  return slash > 0 ? cleaned.slice(slash + 1) : cleaned;
}

function looksLikeCapabilityTagList(value: string): boolean {
  return /^(context|reasoning_effort|effort|fast|thinking)([/,]|$)/i.test(
    value,
  );
}

/** Rich model rows from ACP `configOptions` (deduped, decorations stripped). */
export function modelEntriesFromConfigOptions(
  options: HelmConfigOption[],
): ModelSelectEntry[] {
  const option = findModelOption(options);
  if (!option || option.type !== "select") return [];
  const seen = new Set<string>();
  const out: ModelSelectEntry[] = [];
  for (const wireValue of option.values) {
    const id = stripModelDecoration(wireValue);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = option.valueNames?.[wireValue];
    const capabilityKeys = uniqueNonEmpty([
      ...parseModelCapabilityKeys(wireValue),
      ...parseModelCapabilityKeys(label ?? ""),
    ]);
    out.push({
      id,
      wireValue,
      name: displayNameForModel(wireValue, label),
      capabilityKeys,
    });
  }
  return out;
}

/** Wire ids advertised on ACP `configOptions` (`provider/model`), cleaned. */
export function modelIdsFromConfigOptions(options: HelmConfigOption[]): string[] {
  return modelEntriesFromConfigOptions(options).map((e) => e.id);
}

/**
 * Union of capability keys advertised on model decorations
 * (useful when session/new only tags models, before per-model options load).
 */
export function capabilityKeysFromConfigOptions(
  options: HelmConfigOption[],
): string[] {
  const keys = new Set<string>();
  for (const entry of modelEntriesFromConfigOptions(options)) {
    for (const key of entry.capabilityKeys) keys.add(key);
  }
  return [...keys];
}

export function modelSetConfig(
  options: HelmConfigOption[],
  modelId: string,
): SetConfigPayload | undefined {
  const wanted = modelId.trim();
  if (!wanted) return undefined;
  const option = findModelOption(options);
  if (!option || option.type !== "select") return undefined;
  const cleanedWanted = stripModelDecoration(wanted);
  const value =
    matchSelectValue(option.values, wanted, []) ??
    option.values.find((v) => stripModelDecoration(v) === cleanedWanted) ??
    option.values.find((v) => stripModelDecoration(v).endsWith(`/${cleanedWanted}`)) ??
    option.values.find((v) => cleanedWanted.endsWith(`/${stripModelDecoration(v)}`)) ??
    option.values.find((v) => v.endsWith(`/${wanted}`)) ??
    option.values.find((v) => wanted.endsWith(`/${v}`));
  if (!value) return undefined;
  return { configId: option.id, value };
}

const FAST_ON = ["on", "true", "fast", "enabled", "yes", "1"];
const FAST_OFF = ["off", "false", "standard", "disabled", "no", "slow", "0"];

export function fastSetConfig(
  options: HelmConfigOption[],
  fast: boolean,
): SetConfigPayload | undefined {
  const option =
    options.find((o) => /fast/i.test(optionLabel(o))) ??
    options.find(
      (o) => o.category === "model_config" && /speed|turbo/i.test(optionLabel(o)),
    );
  if (!option) return undefined;
  if (option.type === "boolean") {
    return { configId: option.id, type: "boolean", value: fast };
  }
  const value = matchSelectValue(
    option.values,
    fast ? "on" : "off",
    fast ? FAST_ON : FAST_OFF,
  );
  if (!value) return undefined;
  return { configId: option.id, value };
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
