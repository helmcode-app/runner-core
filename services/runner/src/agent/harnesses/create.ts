/**
 * Resolve AGENT_HARNESS → ACP Server runtime.
 * Every catalog id uses the shared stdio supervisor.
 */

import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { createManagedStdioAcpRuntime } from "./stdio.js";
import type { HarnessOverlay } from "./stdio-settings.js";
import type { HarnessRuntime } from "./types.js";

export function createHarnessRuntime(
  config: AppConfig,
  logger: Logger,
  overlay?: HarnessOverlay,
): HarnessRuntime | null {
  if (!config.SESSIONS_ENABLED) return null;
  return createManagedStdioAcpRuntime(
    config,
    logger,
    config.AGENT_HARNESS,
    overlay,
  );
}
