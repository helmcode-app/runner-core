import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { startCommercialSaas } from "./commercial-saas/index.js";
import { startOpenCore } from "./open-core/index.js";

/**
 * Start the runtime mode selected by HELM_MODE.
 * open-core keeps the process alive via the HTTP server handle.
 * commercial-saas runs an infinite poll loop.
 */
export async function startMode(
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  switch (config.mode) {
    case "open-core":
      await startOpenCore(config, logger);
      return;
    case "commercial-saas":
      await startCommercialSaas(config, logger);
      return;
    default: {
      const _exhaustive: never = config.mode;
      throw new Error(`Unknown HELM_MODE: ${String(_exhaustive)}`);
    }
  }
}

export { startOpenCore, type OpenCoreServer } from "./open-core/index.js";
export { startCommercialSaas } from "./commercial-saas/index.js";
