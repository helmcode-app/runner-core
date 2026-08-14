/**
 * Headless ACP permission policy for `session/request_permission`.
 */

import {
  resolveAgentSettings,
  type AgentSettings,
  type PermissionPolicy,
} from "./settings.js";

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequest {
  options: PermissionOption[];
  toolCall?: { title?: string };
}

export interface PermissionResponse {
  outcome:
    | { outcome: "selected"; optionId: string }
    | { outcome: "cancelled" };
}

/**
 * Auto-resolve permission prompts (runner is not an interactive IDE).
 */
export function resolvePermission(
  settings: Pick<AgentSettings, "permissionPolicy"> | PermissionPolicy,
  params: PermissionRequest,
): PermissionResponse {
  const policy =
    typeof settings === "string"
      ? settings
      : (settings.permissionPolicy ?? resolveAgentSettings().permissionPolicy);
  const options = params.options ?? [];

  if (policy === "deny" || options.length === 0) {
    return { outcome: { outcome: "cancelled" } };
  }

  // Prefer allow-once / allow-always style options when present.
  const preferred =
    options.find((o) => /allow/i.test(o.kind ?? "")) ??
    options.find((o) => /allow/i.test(o.name ?? "")) ??
    options.find((o) => /allow/i.test(o.optionId)) ??
    options[0];

  if (!preferred) {
    return { outcome: { outcome: "cancelled" } };
  }

  return {
    outcome: { outcome: "selected", optionId: preferred.optionId },
  };
}
