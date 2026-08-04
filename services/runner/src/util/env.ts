import { z } from "zod";

/** Compose-friendly boolean env: true/false/1/0 (default applied by Zod when unset). */
export function envBool(defaultValue: boolean = false) {
  return z
    .enum(["true", "false", "1", "0"])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true" || v === "1");
}

/** Clamp integer from query/env strings. */
export function clampInt(
  raw: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
