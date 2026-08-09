import type { OpenCodeModelRef } from "./types.js";

/**
 * Parse client model strings into OpenCode provider/model fields.
 *
 * Accepted forms:
 * - `anthropic/claude-sonnet-4-20250514` → provider + model
 * - `openai/gpt-4o`
 * - `gpt-4o` → model only (OpenCode may resolve via defaults)
 */
export function parseModelRef(raw: string | undefined | null): OpenCodeModelRef | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return {
      raw: trimmed,
      providerID: trimmed.slice(0, slash),
      modelID: trimmed.slice(slash + 1),
    };
  }

  return { raw: trimmed, modelID: trimmed };
}

/**
 * Build the `model` object expected by OpenCode message APIs.
 * Shape: `{ providerID, modelID }` when both known; otherwise omit.
 */
export function toOpenCodeModelField(
  ref: OpenCodeModelRef | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!ref?.providerID || !ref.modelID) return undefined;
  return { providerID: ref.providerID, modelID: ref.modelID };
}
