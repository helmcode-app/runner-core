/**
 * Map Helm prompt knobs (thinkLevel / fast) onto ACP session/set_config_option.
 */

export type HelmConfigOption =
  | {
      id: string;
      type: "select";
      name: string;
      values: string[];
      category?: string;
    }
  | {
      id: string;
      type: "boolean";
      name: string;
      category?: string;
    };

export type SetConfigPayload =
  | { configId: string; type: "boolean"; value: boolean }
  | { configId: string; value: string };

function flattenSelectValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const out: string[] = [];
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value === "string" && rec.value.length > 0) {
      out.push(rec.value);
    }
    if (Array.isArray(rec.options)) {
      out.push(...flattenSelectValues(rec.options));
    }
  }
  return out;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function parseConfigOptions(raw: unknown): HelmConfigOption[] {
  if (!Array.isArray(raw)) return [];
  const out: HelmConfigOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || rec.id.length === 0) continue;
    const name = typeof rec.name === "string" && rec.name.length > 0 ? rec.name : rec.id;
    const category =
      typeof rec.category === "string" && rec.category.length > 0
        ? rec.category
        : undefined;
    if (rec.type === "boolean") {
      out.push({
        id: rec.id,
        type: "boolean",
        name,
        ...(category !== undefined ? { category } : {}),
      });
      continue;
    }
    out.push({
      id: rec.id,
      type: "select",
      name,
      values: flattenSelectValues(rec.options),
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

const THINK_ALIASES: Record<string, string[]> = {
  low: ["minimal", "min"],
  medium: ["default", "normal"],
  high: [],
  xhigh: ["extra-high", "extrahigh", "x-high", "max", "maximum"],
};

export function thinkLevelSetConfig(
  options: HelmConfigOption[],
  thinkLevel: string,
): SetConfigPayload | undefined {
  const wanted = thinkLevel.trim();
  if (!wanted) return undefined;
  const option = findByCategoryOrLabel(
    options,
    "thought_level",
    /thought|think|reason|effort/i,
  );
  if (!option || option.type !== "select") return undefined;
  const aliases = THINK_ALIASES[normalize(wanted)] ?? [];
  const value = matchSelectValue(option.values, wanted, aliases);
  if (!value) return undefined;
  return { configId: option.id, value };
}

function findModelOption(options: HelmConfigOption[]): HelmConfigOption | undefined {
  return (
    options.find((o) => o.category === "model" || o.id === "model") ??
    options.find((o) => /^model$/i.test(o.name))
  );
}

/** Wire ids advertised on ACP `configOptions` (`provider/model`). */
export function modelIdsFromConfigOptions(options: HelmConfigOption[]): string[] {
  const option = findModelOption(options);
  if (!option || option.type !== "select") return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of option.values) {
    const id = value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function modelSetConfig(
  options: HelmConfigOption[],
  modelId: string,
): SetConfigPayload | undefined {
  const wanted = modelId.trim();
  if (!wanted) return undefined;
  const option = findModelOption(options);
  if (!option || option.type !== "select") return undefined;
  const value =
    matchSelectValue(option.values, wanted, []) ??
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
