import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AppConfig } from "../../config.js";
import { AgentPipeline } from "../../agent/index.js";
import type { Logger } from "../../logger.js";
import type { HealthStatus, OpenCoreSubmitBody } from "../../types.js";
import { authorize, readJson, sendJson } from "../../http/index.js";
import {
  createVfsGateway,
  handleVfsHttp,
  type VfsGateway,
} from "../../vfs/index.js";
import {
  httpStatusForResult,
  TaskStore,
} from "./task-store.js";

export interface OpenCoreServer {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  agent: AgentPipeline;
  vfs: VfsGateway;
  close(): Promise<void>;
}

export interface StartOpenCoreOptions {
  installSignalHandlers?: boolean;
}

/**
 * Standalone HTTP + WebSocket API for iPad / local clients (HELM_MODE=open-core).
 * No commercial billing/routing.
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

  const agent = new AgentPipeline({
    config,
    logger,
    onProgress: (event) => store.onProgress(event),
  });

  const vfsHolder: { current: VfsGateway } = {
    current: { bridge: null, close: async () => undefined },
  };

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      log.error("unhandled request error", {
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "internal error",
      });
    }
  });

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/health") {
      const body: HealthStatus = {
        ok: true,
        mode: config.mode,
        version: config.version,
        uptimeMs: Math.floor(process.uptime() * 1000),
        activeTasks: agent.activeTaskCount,
      };
      sendJson(res, 200, body);
      return;
    }

    if (!authorize(req, apiToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (method === "GET" && url.pathname === "/v1/status") {
      sendJson(res, 200, {
        mode: config.mode,
        version: config.version,
        activeTasks: agent.activeTaskCount,
        knownTasks: store.size,
        authRequired: Boolean(apiToken),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/tasks") {
      const body = (await readJson(req)) as OpenCoreSubmitBody;
      const out = store.submitAsync(agent, body);
      if (!out.ok) {
        sendJson(res, out.status, { error: out.error });
        return;
      }
      sendJson(res, 202, {
        id: out.id,
        status: "queued",
        poll: out.poll,
        cancel: out.cancel,
      });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1] ?? "");
      const out = store.cancel(agent, id);
      if (!out.ok) {
        sendJson(res, out.status, {
          error: out.error,
          ...(out.taskStatus !== undefined ? { status: out.taskStatus } : {}),
        });
        return;
      }
      sendJson(res, 202, {
        id,
        status: "cancelled",
        message: "cancel signal sent",
      });
      return;
    }

    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (method === "GET" && taskMatch) {
      const id = decodeURIComponent(taskMatch[1] ?? "");
      const rec = store.get(id);
      if (!rec) {
        sendJson(res, 404, { error: "task not found" });
        return;
      }
      sendJson(res, 200, {
        id,
        status: rec.result?.status ?? rec.liveStatus,
        result: rec.result ?? null,
        events: rec.events,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/tasks/sync") {
      const body = (await readJson(req)) as OpenCoreSubmitBody;
      const out = await store.submitSync(agent, body);
      if (!out.ok) {
        sendJson(res, out.status, { error: out.error });
        return;
      }
      sendJson(res, httpStatusForResult(out.result.status), out.result);
      return;
    }

    if (
      await handleVfsHttp(req, res, method, url.pathname, {
        config,
        bridge: vfsHolder.current.bridge,
        sendJson,
        readJson,
      })
    ) {
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  vfsHolder.current = await createVfsGateway(server, config, logger);

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
  });

  const close = async (): Promise<void> => {
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
    vfs: vfsHolder.current,
    close,
  };
}
