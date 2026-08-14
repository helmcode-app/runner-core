/**
 * Resolve AGENT_HARNESS → ACP Server runtime.
 * Default: OpenCode (`opencode acp` over stdio).
 */

import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { createManagedOpenCodeAcpRuntime } from "./opencode/process.js";
import type { OpenCodeHarnessSettings } from "./opencode/settings.js";
import type { HarnessRuntime } from "./types.js";

export function createHarnessRuntime(
  config: AppConfig,
  logger: Logger,
  overlay?: Partial<OpenCodeHarnessSettings>,
): HarnessRuntime | null {
  if (!config.SESSIONS_ENABLED) return null;

  switch (config.AGENT_HARNESS) {
    case "opencode":
      return createManagedOpenCodeAcpRuntime(config, logger, overlay);
    default: {
      const harness: string = config.AGENT_HARNESS;
      throw new Error(`Unsupported AGENT_HARNESS: ${harness}`);
    }
  }
}
