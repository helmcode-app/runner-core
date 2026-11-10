/**
 * Agent runtime: ACP Client + harness ACP Server + product gateway.
 *
 * Selection lives in `$WORKSPACES_PATH/.setup/agent.json` (client PUT /v1/agent).
 * Env `SESSIONS_ENABLED` / `AGENT_*` bootstraps when no file exists.
 * Every catalog id shares the stdio supervisor.
 */

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { AgentGateway } from "./gateway.js";
import { createHarnessRuntime } from "./harnesses/create.js";
import type { HarnessRuntime } from "./harnesses/types.js";
import type { HarnessOverlay } from "./harnesses/stdio-settings.js";
import type { WorkspaceRegistry } from "../workspaces/index.js";

export { AgentGateway, pickAcpModeId } from "./gateway.js";
export {
  AgentCapabilityError,
  AgentNotFoundError,
  AgentRuntimeError,
} from "./errors.js";
export { createHarnessRuntime } from "./harnesses/create.js";
export type {
  HarnessModeIds,
  HarnessRuntime,
  HarnessStatus,
} from "./harnesses/types.js";
export {
  AGENT_HARNESS_IDS,
  HARNESS_SPECS,
  childAuthEnv,
  connectedProviderIds,
  harnessNeedsProvider,
  harnessSpec,
  type AgentHarnessId,
  type HarnessAuthKind,
  type HarnessSpec,
} from "./harnesses/catalog.js";
export {
  CLAUDE_HARNESS_OVERLAY,
  CODEX_HARNESS_OVERLAY,
  CURSOR_HARNESS_OVERLAY,
  GROK_HARNESS_OVERLAY,
  OPENCODE_HARNESS_OVERLAY,
  resolveStdioHarnessSettings,
  type HarnessOverlay,
  type StdioHarnessSettings,
} from "./harnesses/stdio-settings.js";
export {
  createManagedStdioAcpRuntime,
  type ManagedStdioAcpRuntime,
  type ManagedStdioAcpStatus,
} from "./harnesses/stdio.js";
export {
  defaultHarnessPrefix,
  defaultOpenCodePrefix,
  installCurlScript,
  installNpmPackage,
  npmPackageSpec,
  resolveHarnessBinPath,
} from "./harnesses/install.js";
export {
  AGENT_PROVIDER_AUTH_IDS,
  AGENT_PROVIDER_IDS,
  buildOpenCodeAuthFile,
  enabledOpenCodeProviderIds,
  isAgentProviderId,
  materializeOpenCodeAuth,
  normalizeAgentProviderId,
  resolveOpenCodeAuthPath,
  resolveOpenCodeAuthProviders,
  resolveOpenCodeHome,
  serializeOpenCodeAuthFile,
  type AgentProviderId,
  type OpenCodeAuthFile,
  type OpenCodeAuthProviderSlot,
  type OpenCodeHomeSettings,
} from "./harnesses/opencode/auth.js";
export {
  AGENT_SETTINGS_DEFAULTS,
  AGENT_SETTINGS_OVERLAY,
  resolveAgentSettings,
  type AgentSettings,
  type PermissionPolicy,
} from "./settings.js";
export {
  clearModelsCatalogCache,
  loadAgentModelsCatalog,
} from "./models.js";
export {
  mapAcpSessionUpdate,
  mapStopReason,
  mergeSessionUsage,
  parseSessionUsage,
  usageFromPromptResult,
} from "./map-updates.js";
export {
  capabilityKeysFromConfigOptions,
  contextLevelsFromConfigOptions,
  contextSetConfig,
  currentContextFromConfigOptions,
  fastLevelsFromConfigOptions,
  fastSetConfig,
  modelEntriesFromConfigOptions,
  modelIdsFromConfigOptions,
  modelSetConfig,
  parseConfigOptions,
  parseContextTokens,
  parseModelCapabilityKeys,
  stripModelDecoration,
  supportsFastFromConfigOptions,
  thinkingLevelsFromConfigOptions,
  thinkingSetConfig,
  thinkLevelsFromConfigOptions,
  thinkLevelSetConfig,
} from "./session-config.js";
export { resolvePermission } from "./permissions.js";
export {
  captureWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  isGitWorkTree,
} from "./checkpoint.js";
export {
  formatSeedContext,
  parseRewindRestore,
  planRewind,
  type RewindRestore,
  type SessionCheckpoint,
} from "./rewind.js";
export {
  SessionStore,
  defaultSessionsDir,
  fromPersistedSession,
  parsePersistedSession,
  toPersistedSession,
  type PersistedSession,
} from "./persist.js";
export {
  AGENT_CONFIG_VERSION,
  agentConfigFromEnv,
  defaultAgentConfigPath,
  effectiveAppConfig,
  loadPersistedAgentConfig,
  sanitizePersistedAgentConfig,
  mergeAgentConfigUpdate,
  parsePersistedAgentConfig,
  redactApiKey,
  savePersistedAgentConfig,
  validateAgentConfig,
  type AgentConfigSource,
  type AgentConfigUpdate,
  type PersistedAgentConfig,
} from "./config-store.js";
export {
  AgentConfigError,
  createAgentRuntimeController,
  type AgentConfigView,
  type AgentRuntimeController,
  type AgentRuntimePhase,
  type CreateAgentRuntimeControllerOptions,
  type HarnessCatalogEntry,
} from "./runtime-controller.js";
export { handleAgentHttp, type AgentRouteContext } from "./routes.js";

export interface AgentRuntime {
  gateway: AgentGateway;
  harness: HarnessRuntime;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build a one-shot agent runtime from an already-enabled AppConfig.
 * Prefer `createAgentRuntimeController` for product boot + harness switching.
 */
export function createAgentRuntime(
  config: AppConfig,
  logger: Logger,
  opts?: {
    harnessOverlay?: HarnessOverlay;
    workspaces?: WorkspaceRegistry;
  },
): AgentRuntime | null {
  if (!config.SESSIONS_ENABLED) return null;

  const harness = createHarnessRuntime(config, logger, opts?.harnessOverlay);
  if (!harness) {
    throw new Error(
      `Failed to create ACP harness runtime (${config.AGENT_HARNESS})`,
    );
  }

  const gateway = new AgentGateway(
    config,
    logger.child({ component: "agent-gateway" }),
    () => harness.getConnection(),
    harness,
    opts?.workspaces,
  );

  harness.setSessionUpdateHandler((params) => {
    gateway.handleAcpUpdate(params);
  });

  return {
    gateway,
    harness,
    async start() {
      // Explicit one-shot start (env/CI): allow install.
      await harness.start({ install: true });
      await gateway.restore();
    },
    async stop() {
      await gateway.flush();
      await harness.stop();
    },
  };
}
