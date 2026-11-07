import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  createAgentRuntime,
  type AgentGateway,
  type AgentRuntime,
} from "../../agent/index.js";
import type { HarnessOverlay } from "../../agent/harnesses/stdio-settings.js";
import type { AppConfig } from "../../config.js";
import { sendJson } from "../../http/index.js";
import type { Logger } from "../../logger.js";
import {
  createTerminalGateway,
  type TerminalGateway,
} from "../../terminal/index.js";
import { createVfsGateway, type VfsGateway } from "../../vfs/index.js";
import { createWorkspaceRegistry } from "../../workspaces/index.js";
import { SetupController } from "../../setup/index.js";
import { handleOpenCoreRequest } from "./routes.js";

export interface OpenCoreServer {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  vfs: VfsGateway;
  terminal: TerminalGateway;
  /** ACP agent gateway when sessions are enabled. */
  agentGateway: AgentGateway | null;
  agentRuntime: AgentRuntime | null;
  close(): Promise<void>;
}

export interface StartOpenCoreOptions {
  installSignalHandlers?: boolean;
  /** Test/smoke overlay for harness install paths (not env). */
  harnessOverlay?: HarnessOverlay;
}

/**
 * Standalone HTTP + WebSocket API for iPad / local clients (HELM_MODE=open-core).
 *
 * Unified ingress (same host/port):
 * - `/v1/workspaces` — workspace catalog (default = MAIN_REPO_PATH)
 * - `/v1/vfs`        — VFS JSON-RPC (`?workspaceId=`)
 * - `/v1/terminal`   — WebSSH (`?workspaceId=`)
 * - `/v1/sessions`   — agent sessions (ACP Client → harness ACP Server)
 */
export async function startOpenCore(
  config: AppConfig,
  logger: Logger,
  opts: StartOpenCoreOptions = {},
): Promise<OpenCoreServer> {
  const log = logger.child({ component: "open-core" });
  const installSignals = opts.installSignalHandlers !== false;
  const workspaces = await createWorkspaceRegistry(config);
  const setup = await SetupController.create(config, logger, { workspaces });
  const authorizeUpgrade = (req: IncomingMessage, url: URL) =>
    setup.authorizeUpgrade(req, url);

  log.info("open-core API auth enabled (device tokens)", {
    setupPhase: setup.operatorStatus().phase,
  });

  const agentRuntime = createAgentRuntime(config, logger, {
    workspaces,
    ...(opts.harnessOverlay ? { harnessOverlay: opts.harnessOverlay } : {}),
  });
  if (agentRuntime) {
    log.info("starting agent runtime", {
      harness: config.AGENT_HARNESS,
      transport: "stdio",
      managed: true,
    });
    await agentRuntime.start();
  }

  const agentGateway = agentRuntime?.gateway ?? null;
  if (agentGateway) {
    log.info("agent sessions enabled", {
      harness: config.AGENT_HARNESS,
      provider: "acp",
    });
  }

  let vfs: VfsGateway = {
    bridge: null,
    pool: null,
    getBridge: () => null,
    close: async () => undefined,
  };

  const server = createServer(async (req, res) => {
    try {
      await handleOpenCoreRequest(req, res, {
        config,
        getBridge: (workspaceId) => vfs.getBridge(workspaceId),
        workspaces,
        agentGateway,
        setup,
        logger,
      });
    } catch (err) {
      log.error("unhandled request error", {
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "internal error",
      });
    }
  });

  vfs = await createVfsGateway(
    server,
    config,
    logger,
    workspaces,
    authorizeUpgrade,
  );
  const terminal = createTerminalGateway(
    server,
    config,
    logger,
    workspaces,
    authorizeUpgrade,
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.PORT, config.HOST, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind open-core HTTP server");
  }

  const host = config.HOST === "0.0.0.0" ? "127.0.0.1" : config.HOST;
  const port = address.port;
  log.info("open-core listening", {
    host: config.HOST,
    port,
    vfs: Boolean(vfs.bridge),
    terminalWs: terminal.enabled ? "/v1/terminal" : "disabled",
    sessions: agentGateway ? `acp:${config.AGENT_HARNESS}` : "disabled",
  });

  const close = async (): Promise<void> => {
    await terminal.close();
    await vfs.close();
    if (agentRuntime) {
      await agentRuntime.stop();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  if (installSignals) {
    const shutdown = (): void => {
      log.info("open-core shutting down");
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  return {
    server,
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    vfs,
    terminal,
    agentGateway,
    agentRuntime,
    close,
  };
}
