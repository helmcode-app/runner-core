#!/usr/bin/env node
/**
 * Unified entrypoint for HelmCode runner-core.
 *
 * HELM_MODE=open-core        → standalone HTTP API on :8080 (iPad / local)
 * HELM_MODE=commercial-saas  → headless JSON-RPC worker under commercial gateway
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startCommercialSaas } from "./modes/commercial-saas.js";
import { startOpenCore } from "./modes/open-core.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info("runner-core boot", {
    mode: config.mode,
    node: process.version,
    mainRepo: config.MAIN_REPO_PATH,
    workspaces: config.WORKSPACES_PATH,
  });

  switch (config.mode) {
    case "open-core": {
      // Keep process alive via the listening server handle.
      await startOpenCore(config, logger);
      break;
    }
    case "commercial-saas":
      await startCommercialSaas(config, logger);
      break;
    default: {
      const _exhaustive: never = config.mode;
      throw new Error(`Unknown HELM_MODE: ${String(_exhaustive)}`);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "fatal",
      error: message,
    }) + "\n",
  );
  process.exit(1);
});
