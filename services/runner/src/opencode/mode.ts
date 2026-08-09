import type { OpenCodeMode } from "./types.js";

/**
 * Map HelmCode composer modes onto OpenCode `agent` names.
 *
 * OpenCode lists agents via `GET /agent`. Common built-ins include
 * build/plan-style agents; exact names depend on the installed opencode version.
 * Override with OPENCODE_AGENT_* env if your deployment differs.
 */
export interface ModeMapping {
  /** OpenCode `agent` field for POST /session/:id/message|prompt_async */
  agent: string;
  /** Optional system preamble for read-only modes. */
  systemPreamble?: string;
}

const PLAN_PREAMBLE = [
  "You are in PLAN mode (read-only architectural analysis).",
  "Do not modify files, run mutating shell commands, or apply patches.",
  "Produce a clear, ordered plan with risks, files to touch, and test strategy.",
].join(" ");

const ASK_PREAMBLE = [
  "You are in ASK mode (Q&A only).",
  "Answer using the codebase context. Do not modify files or run mutating tools.",
].join(" ");

export function resolveModeMapping(
  mode: OpenCodeMode | undefined,
  env: {
    agentName?: string;
    planAgentName?: string;
    askAgentName?: string;
  } = {},
): ModeMapping {
  const m = mode ?? "agent";
  switch (m) {
    case "plan":
      // Prefer named plan agent; fall back to build + preamble (some installs lack "plan").
      return {
        agent: env.planAgentName?.trim() || "plan",
        systemPreamble: PLAN_PREAMBLE,
      };
    case "ask":
      // Default to build + ask preamble — "ask" agent is not present on all OpenCode builds
      // and invalid agent names can accept prompt_async then produce no messages.
      return {
        agent: env.askAgentName?.trim() || "build",
        systemPreamble: ASK_PREAMBLE,
      };
    case "agent":
    default:
      return {
        agent: env.agentName?.trim() || "build",
      };
  }
}

export function normalizeMode(raw: unknown): OpenCodeMode {
  if (raw === "plan" || raw === "ask" || raw === "agent") return raw;
  if (typeof raw === "string") {
    const lower = raw.trim().toLowerCase();
    if (lower === "plan" || lower === "ask" || lower === "agent") return lower;
  }
  return "agent";
}
