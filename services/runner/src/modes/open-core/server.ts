import { createServer, type Server } from "node:http";
import {
  AgentPipeline,
  createAgentGateway,
  type AgentGateway,
} from "../../agent/index.js";
import type { AppConfig } from "../../config.js";
import { sendJson } from "../../http/index.js";
import type { Logger } from "../../logger.js";
import {
  createTerminalGateway,
  type TerminalGateway,
} from "../../terminal/index.js";
import type { TaskProgressEvent } from "../../types.js";
import {
  createVfsGateway,
  type VfsGateway,
} from "../../vfs/index.js";
import { handleOpenCoreRequest } from "./routes.js";
import { TaskStore } from "./task-store.js";

export interface OpenCoreServer {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  agent: AgentPipeline;
  agentGateway: AgentGateway;
  vfs: VfsGateway;
  terminal: TerminalGateway;
  close(): Promise<void>;
}

export interface StartOpenCoreOptions {
  installSignalHandlers?: boolean;
}

/**
 * Standalone HTTP + WebSocket API for iPad / local clients (HELM_MODE=open-core).
 *
 * Unified ingress (same host/port):
 * - `/v1/vfs`       — VFS JSON-RPC
 * - `/v1/agent`     — Agent JSON-RPC
 * - `/v1/terminal`  — WebSSH (in-process PTY); alias `/api/v1/terminal/ws`
 */
export async function startOpenCore(
  config: AppConfig,
  logger: Logger,
  opts: StartOpenCoreOptions = {},
): Promise<OpenCoreServer> {
  const log = logger.child({ component: "open-core" });
  const store = new TaskStore();
  const installSignals = opts.installSignalHandlers !== false;
  const apiToken = config.OPENCORE_API_TOKEN?.trim() || undefined;

  if (!apiToken) {
    log.warn(
      "OPENCORE_API_TOKEN unset — open-core HTTP API is unauthenticated (dev only)",
    );
  } else {
    log.info("open-core API auth enabled (Bearer token)");
  }

  // Progress: persist in task store + fan-out on agent WebSocket (bound after gateway).
  const progressSinks: Array<(event: TaskProgressEvent) => void> = [
    (event) => store.onProgress(event),
  ];
  const onProgress = (event: TaskProgressEvent): void => {
    for (const sink of progressSinks) sink(event);
  };

  const agent = new AgentPipeline({ config, logger, onProgress });

  let vfs: VfsGateway = { bridge: null, close: async () => undefined };

  const server = createServer(async (req, res) => {
    try {
      await handleOpenCoreRequest(req, res, {
        config,
        agent,
        store,
        apiToken,
        getBridge: () => vfs.bridge,
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

  // WebSocket gateways share the HTTP server (no extra ports).
  vfs = await createVfsGateway(server, config, logger);
  const agentGateway = createAgentGateway(
    server,
    agent.underlying,
    config,
    logger,
  );
  progressSinks.push((event) => agentGateway.broadcastProgress(event));
  const terminal = createTerminalGateway(server, config, logger);

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
    agentWs: "/v1/agent",
    terminalWs: terminal.enabled ? "/v1/terminal" : "disabled",
  });

  const close = async (): Promise<void> => {
    await terminal.close();
    await agentGateway.close();
    await vfs.close();
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
    agent,
    agentGateway,
    vfs,
    terminal,
    close,
  };
}
