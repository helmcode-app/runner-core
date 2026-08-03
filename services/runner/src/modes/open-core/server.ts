import { createServer, type Server } from "node:http";
import {
  AgentPipeline,
  createAgentGateway,
  type AgentGateway,
} from "../../agent/index.js";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import type { TaskProgressEvent } from "../../types.js";
import { sendJson } from "../../http/index.js";
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
  close(): Promise<void>;
}

export interface StartOpenCoreOptions {
  installSignalHandlers?: boolean;
}

/**
 * Standalone HTTP + WebSocket API for iPad / local clients (HELM_MODE=open-core).
 *
 * WebSocket endpoints:
 * - `/v1/vfs`  — VFS JSON-RPC (file tree / read_chunk / write)
 * - `/v1/agent` — Agent JSON-RPC (`agent/run`, cancel, status)
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

  // Progress sinks: task store + live agent WebSocket fan-out (bound after gateway).
  let agentGatewayRef: AgentGateway | null = null;
  const onProgress = (event: TaskProgressEvent): void => {
    store.onProgress(event);
    agentGatewayRef?.broadcastProgress(event);
  };

  const agent = new AgentPipeline({
    config,
    logger,
    onProgress,
  });

  const vfsHolder: { current: VfsGateway } = {
    current: { bridge: null, close: async () => undefined },
  };

  const server = createServer(async (req, res) => {
    try {
      await handleOpenCoreRequest(req, res, {
        config,
        agent,
        store,
        apiToken,
        getBridge: () => vfsHolder.current.bridge,
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

  // VFS WS gateway (/v1/vfs)
  vfsHolder.current = await createVfsGateway(server, config, logger);

  // Agent WS gateway (/v1/agent) — shares the same HelmCodeAgentEngine.
  const agentGateway = createAgentGateway(
    server,
    agent.underlying,
    config,
    logger,
  );
  agentGatewayRef = agentGateway;

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
    vfs: Boolean(vfsHolder.current.bridge),
    agentWs: "/v1/agent",
  });

  const close = async (): Promise<void> => {
    await agentGateway.close();
    await vfsHolder.current.close();
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
    vfs: vfsHolder.current,
    close,
  };
}
