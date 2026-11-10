#!/usr/bin/env node
/**
 * Unified entrypoint for HelmCode runner-core.
 *
 * HELM_MODE=open-core → HTTP + WebSocket API (sessions / VFS / terminal)
 */
import { statSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { startMode } from "./modes/index.js";
import { SetupController } from "./setup/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  const command = process.argv[2];
  if (
    command === "setup:enroll" ||
    command === "setup:recover" ||
    command === "setup:browser" ||
    command === "setup:claim"
  ) {
    if (command === "setup:claim") {
      process.stderr.write(
        "setup:claim has been removed.\nUse setup:enroll, or setup:recover if every device is gone.\n",
      );
      process.exitCode = 1;
      return;
    }
    dropToWorkspaceOwner(config.WORKSPACES_PATH);
    const { createWorkspaceRegistry } = await import("./workspaces/index.js");
    const workspaces = await createWorkspaceRegistry(config);
    const setup = await SetupController.create(config, logger, {
      quiet: true,
      workspaces,
    });
    try {
      if (command === "setup:enroll") {
        await setup.printEnrollCode();
        return;
      }
      if (command === "setup:recover") {
        await setup.printRecoverCode();
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
    const code = await setup.printBrowserCode();
    process.stdout.write(
      `Helm browser code: ${code}\nEnter it on the runner setup page. It does not pair a device.\n`,
    );
    return;
  }

  logger.info("runner-core boot", {
    mode: config.mode,
    node: process.version,
    mainRepo: config.MAIN_REPO_PATH,
    workspaces: config.WORKSPACES_PATH,
    sessionsEnvBootstrap: config.SESSIONS_ENABLED,
    agentHarnessEnv: config.SESSIONS_ENABLED
      ? config.AGENT_HARNESS
      : undefined,
  });

  await startMode(config, logger);
}

function dropToWorkspaceOwner(workspacesPath: string): void {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  if (typeof process.setgid !== "function" || typeof process.setuid !== "function") return;
  try {
    const owner = statSync(workspacesPath);
    if (owner.uid === 0) return;
    process.setgid(owner.gid);
    process.setuid(owner.uid);
  } catch {
    /* writers also chown setup files back to the workspace owner */
  }
}

main().catch((err: unknown) => {
  const message =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
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
