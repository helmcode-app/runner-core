/**
 * Product-level agent defaults (not env).
 *
 * Edit AGENT_SETTINGS_OVERLAY when you need a local override — same idea as
 * dropping a config file next to a harness. Keep `.env` to secrets + selection.
 */

export type PermissionPolicy = "allow" | "deny";

export interface AgentSettings {
 /** Headless ACP `session/request_permission` policy. */
 permissionPolicy: PermissionPolicy;
 /** Extra `provider/model` ids for GET /v1/sessions/models. */
 extraModels: string[];
 /** ACP `session/new` cwd (default MAIN_REPO_PATH). */
 cwd?: string;
 /** Directory for durable Helm session JSON (default `$WORKSPACES_PATH/.sessions`). */
 sessionsDir?: string;
}

export const AGENT_SETTINGS_DEFAULTS: AgentSettings = {
 permissionPolicy: "allow",
 extraModels: [],
};

/**
 * Local overrides. Leave empty to use defaults.
 *
 * @example
 * export const AGENT_SETTINGS_OVERLAY = {
 *   extraModels: ["opencode-go/glm-5.2"],
 * };
 */
export const AGENT_SETTINGS_OVERLAY: Partial<AgentSettings> = {};

export function resolveAgentSettings(
 overlay?: Partial<AgentSettings>,
): AgentSettings {
 const extraModels =
  overlay?.extraModels ??
  AGENT_SETTINGS_OVERLAY.extraModels ??
  AGENT_SETTINGS_DEFAULTS.extraModels;
 const cwd = overlay?.cwd ?? AGENT_SETTINGS_OVERLAY.cwd;
 const sessionsDir =
  overlay?.sessionsDir?.trim() || AGENT_SETTINGS_OVERLAY.sessionsDir?.trim();
 return {
  permissionPolicy:
   overlay?.permissionPolicy ??
   AGENT_SETTINGS_OVERLAY.permissionPolicy ??
   AGENT_SETTINGS_DEFAULTS.permissionPolicy,
  extraModels: [...extraModels],
  ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
  ...(sessionsDir ? { sessionsDir } : {}),
 };
}
