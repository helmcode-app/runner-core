/** AGENT_HARNESS values. Kept tiny so `config.ts` can import without the catalog. */

export const AGENT_HARNESS_IDS = [
  "opencode",
  "claude",
  "codex",
  "cursor",
  "grok",
] as const;

export type AgentHarnessId = (typeof AGENT_HARNESS_IDS)[number];
