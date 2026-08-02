#!/usr/bin/env node
/**
 * Unified entrypoint for HelmCode runner-core.
 *
 * HELM_MODE=open-core        → standalone HTTP API on :8080 (iPad / local)
 * HELM_MODE=commercial-saas  → headless JSON-RPC worker under commercial gateway
 */
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startMode } from "./modes/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info("runner-core boot", {
    mode: config.mode,
    node: process.version,
    mainRepo: config.MAIN_REPO_PATH,
    workspaces: config.WORKSPACES_PATH,
  });

  await startMode(config, logger);
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
