/**
 * Agent runtime: ACP Client + harness ACP Server + product gateway.
 *
 * Default harness is OpenCode (`AGENT_HARNESS=opencode` → `opencode acp`).
 */

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { AgentGateway } from "./gateway.js";
import { createHarnessRuntime } from "./harnesses/create.js";
import type { HarnessRuntime } from "./harnesses/types.js";
import {
  resolveOpenCodeHarnessSettings,
  type OpenCodeHarnessSettings,
} from "./harnesses/opencode/settings.js";

export { AgentGateway, pickAcpModeId } from "./gateway.js";
export {
  AgentCapabilityError,
  AgentNotFoundError,
  AgentRuntimeError,
} from "./errors.js";
export { createHarnessRuntime } from "./harnesses/create.js";
export type { HarnessRuntime, HarnessStatus } from "./harnesses/types.js";
export {
  AGENT_PROVIDER_AUTH_IDS,
  buildOpenCodeAuthFile,
  enabledOpenCodeProviderIds,
  materializeOpenCodeAuth,
  resolveOpenCodeAuthPath,
  resolveOpenCodeAuthProviders,
  resolveOpenCodeHome,
  serializeOpenCodeAuthFile,
  type AgentProviderId,
  type OpenCodeAuthFile,
  type OpenCodeAuthProviderSlot,
} from "./harnesses/opencode/auth.js";
export {
  createManagedOpenCodeAcpRuntime,
  openCodePackageSpec,
  resolveOpenCodeBinaryPath,
  type ManagedOpenCodeAcpRuntime,
  type ManagedOpenCodeAcpStatus,
} from "./harnesses/opencode/process.js";
export {
  OPENCODE_HARNESS_DEFAULTS,
  OPENCODE_HARNESS_OVERLAY,
  defaultOpenCodePrefix,
  resolveOpenCodeHarnessSettings,
  type OpenCodeHarnessSettings,
} from "./harnesses/opencode/settings.js";
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
export { mapAcpSessionUpdate, mapStopReason } from "./map-updates.js";
export { resolvePermission } from "./permissions.js";

export interface AgentRuntime {
  gateway: AgentGateway;
  harness: HarnessRuntime;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build agent runtime when SESSIONS_ENABLED.
 * Default ACP Server: OpenCode. Add harnesses in `harnesses/create.ts`.
 */
export function createAgentRuntime(
  config: AppConfig,
  logger: Logger,
  opts?: { harnessOverlay?: Partial<OpenCodeHarnessSettings> },
): AgentRuntime | null {
  if (!config.SESSIONS_ENABLED) return null;

  const harness = createHarnessRuntime(config, logger, opts?.harnessOverlay);
  if (!harness) {
    throw new Error(
      `Failed to create ACP harness runtime (${config.AGENT_HARNESS})`,
    );
  }

  const harnessSettings = resolveOpenCodeHarnessSettings(opts?.harnessOverlay);
  const gateway = new AgentGateway(
    config,
    logger.child({ component: "agent-gateway" }),
    () => harness.getConnection(),
    harness,
    harnessSettings,
  );

  harness.setSessionUpdateHandler((params) => {
    gateway.handleAcpUpdate(params);
  });

  return {
    gateway,
    harness,
    async start() {
      await harness.start();
    },
    async stop() {
      await harness.stop();
    },
  };
}
