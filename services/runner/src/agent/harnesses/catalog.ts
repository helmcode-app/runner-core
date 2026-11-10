/**
 * ACP harness catalog — spawn, auth, and provider policy for every
 * harness id (`/v1/agent` or env bootstrap). The stdio supervisor reads this;
 * do not add a second process manager per vendor.
 *
 * Two kinds:
 * - multi-provider (`opencode`, later `pi` / `goose`): harness + provider + apiKey
 * - single-vendor (`claude` / `codex` / `cursor` / `grok`): harness + apiKey
 *   provider is unused (the harness is the vendor).
 */

import type { AppConfig } from "../../config.js";
import { type AgentHarnessId } from "./ids.js";
import { defaultOpenCodePrefix } from "./install.js";
import { enabledOpenCodeProviderIds } from "./opencode/auth.js";
import type { HarnessModeIds } from "./types.js";

export { AGENT_HARNESS_IDS, type AgentHarnessId } from "./ids.js";

export type HarnessProviderPolicy = "required" | "unused";

/** How the child process receives credentials. */
export type HarnessAuthKind = "opencode-json" | "env";

export interface HarnessSpec {
  id: AgentHarnessId;
  /** Whether AGENT_PROVIDER selects an LLM vendor inside this process. */
  providers: HarnessProviderPolicy;
  /** Model-catalog provider id when `providers === "unused"`. */
  impliedProvider: string;
  auth: HarnessAuthKind;
  /** Child env var that receives AGENT_API_KEY (`auth: "env"`). */
  apiKeyEnv?: string;
  /** Extra names that also get AGENT_API_KEY when unset (e.g. Codex). */
  apiKeyAliases?: string[];
  extraEnv?: Record<string, string>;
  /** npm package to install into `$prefix` (omit for PATH-only / curl CLIs). */
  packageName?: string;
  /**
   * Official installer URL when the CLI is not on npm (e.g. Cursor).
   * Runner downloads + runs the script on first enable / switch.
   */
  curlInstallUrl?: string;
  /** Binary name under `$prefix/bin` after npm install. */
  binName: string;
  args: string[];
  /** PATH lookup names when `bin` overlay is unset. */
  pathCandidates: string[];
  requireApiKey: boolean;
  modes: HarnessModeIds;
  /** Override `defaultHarnessPrefix(id)` (OpenCode keeps `/app/.opencode`). */
  defaultPrefix?: () => string;
}

export const HARNESS_SPECS: Record<AgentHarnessId, HarnessSpec> = {
  opencode: {
    id: "opencode",
    providers: "required",
    impliedProvider: "opencode",
    auth: "opencode-json",
    packageName: "opencode-ai",
    binName: "opencode",
    args: ["acp"],
    pathCandidates: ["opencode"],
    requireApiKey: true,
    modes: { agent: "build", plan: "plan", ask: "ask" },
    defaultPrefix: defaultOpenCodePrefix,
  },
  claude: {
    id: "claude",
    providers: "unused",
    impliedProvider: "anthropic",
    auth: "env",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    packageName: "@agentclientprotocol/claude-agent-acp",
    binName: "claude-agent-acp",
    args: [],
    pathCandidates: ["claude-agent-acp"],
    requireApiKey: true,
    modes: { agent: "code", plan: "plan", ask: "ask" },
  },
  codex: {
    id: "codex",
    providers: "unused",
    impliedProvider: "openai",
    auth: "env",
    apiKeyEnv: "CODEX_API_KEY",
    apiKeyAliases: ["OPENAI_API_KEY"],
    extraEnv: { NO_BROWSER: "1" },
    packageName: "@agentclientprotocol/codex-acp",
    binName: "codex-acp",
    args: [],
    pathCandidates: ["codex-acp"],
    requireApiKey: true,
    modes: { agent: "default", plan: "plan", ask: "ask" },
  },
  cursor: {
    id: "cursor",
    providers: "unused",
    impliedProvider: "cursor",
    auth: "env",
    apiKeyEnv: "CURSOR_API_KEY",
    curlInstallUrl: "https://cursor.com/install",
    binName: "agent",
    args: ["acp"],
    pathCandidates: ["agent", "cursor-agent"],
    requireApiKey: true,
    modes: { agent: "agent", plan: "plan", ask: "ask" },
  },
  grok: {
    id: "grok",
    providers: "unused",
    impliedProvider: "xai",
    auth: "env",
    apiKeyEnv: "XAI_API_KEY",
    packageName: "@xai-official/grok",
    binName: "grok",
    args: ["agent", "stdio"],
    pathCandidates: ["grok"],
    requireApiKey: true,
    modes: { agent: "agent", plan: "plan", ask: "ask" },
  },
};

export function harnessSpec(id: AgentHarnessId): HarnessSpec {
  return HARNESS_SPECS[id];
}

export function harnessNeedsProvider(id: AgentHarnessId): boolean {
  return HARNESS_SPECS[id].providers === "required";
}

/** Provider ids the models catalog should mark connected. */
export function connectedProviderIds(config: AppConfig): string[] {
  const spec = HARNESS_SPECS[config.AGENT_HARNESS];
  if (spec.providers === "required") {
    return enabledOpenCodeProviderIds(config);
  }
  if (config.AGENT_API_KEY?.trim() || !spec.requireApiKey) {
    return [spec.impliedProvider];
  }
  return [];
}

export function childAuthEnv(
  config: AppConfig,
  spec: HarnessSpec,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...spec.extraEnv };
  const key = config.AGENT_API_KEY?.trim();
  if (key && spec.apiKeyEnv) {
    env[spec.apiKeyEnv] = key;
    for (const alias of spec.apiKeyAliases ?? []) {
      env[alias] = env[alias] || key;
    }
  }
  return env;
}
