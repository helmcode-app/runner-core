import { createServer, type Server } from "node:http";
import type { AppConfig } from "../../config.js";
import { sendJson } from "../../http/index.js";
import type { Logger } from "../../logger.js";
import {
  createManagedOpenCodeRuntime,
  createOpenCodeClient,
  type ManagedOpenCodeRuntime,
  type OpenCodeClient,
} from "../../opencode/index.js";
import {
  createTerminalGateway,
  type TerminalGateway,
} from "../../terminal/index.js";
import {
  createVfsGateway,
  type VfsGateway,
} from "../../vfs/index.js";
import { handleOpenCoreRequest } from "./routes.js";

export interface OpenCoreServer {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  vfs: VfsGateway;
  terminal: TerminalGateway;
  /** Pluggable session runtime (OpenCode adapter today). */
  sessionRuntime: OpenCodeClient | null;
  /** Local install/serve supervisor when OPENCODE_MANAGED. */
  managedOpenCode: ManagedOpenCodeRuntime | null;
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
 * - `/v1/terminal`  — WebSSH (in-process PTY)
 * - `/v1/sessions`  — agent sessions (OpenCode runtime adapter)
 */
export async function startOpenCore(
  config: AppConfig,
  logger: Logger,
  opts: StartOpenCoreOptions = {},
): Promise<OpenCoreServer> {
  const log = logger.child({ component: "open-core" });
  const installSignals = opts.installSignalHandlers !== false;
  const apiToken = config.OPENCORE_API_TOKEN?.trim() || undefined;

  if (!apiToken) {
    log.warn(
      "OPENCORE_API_TOKEN unset — open-core HTTP API is unauthenticated (dev only)",
    );
  } else {
    log.info("open-core API auth enabled (Bearer token)");
  }

  // Managed OpenCode: install at boot + start serve before HTTP client connects.
  const managedOpenCode = createManagedOpenCodeRuntime(config, logger);
  if (managedOpenCode) {
    log.info("starting managed OpenCode runtime", {
      version: config.OPENCODE_VERSION,
      prefix: config.OPENCODE_PREFIX,
      updateIntervalHours: config.OPENCODE_UPDATE_INTERVAL_HOURS,
    });
    await managedOpenCode.start();
  }

  const sessionRuntime = createOpenCodeClient(config, logger);
  if (sessionRuntime) {
    log.info("agent sessions enabled", {
      runtime: sessionRuntime.baseUrl,
      managed: Boolean(managedOpenCode),
    });
  }

  let vfs: VfsGateway = { bridge: null, close: async () => undefined };

  const server = createServer(async (req, res) => {
    try {
      await handleOpenCoreRequest(req, res, {
        config,
        apiToken,
        getBridge: () => vfs.bridge,
        sessionRuntime,
        managedOpenCode,
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

  // WebSocket gateways share the HTTP server (no extra ports).
  vfs = await createVfsGateway(server, config, logger);
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
    terminalWs: terminal.enabled ? "/v1/terminal" : "disabled",
    sessions: sessionRuntime ? sessionRuntime.baseUrl : "disabled",
  });

  const close = async (): Promise<void> => {
    await terminal.close();
    await vfs.close();
    if (managedOpenCode) {
      await managedOpenCode.stop();
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
    sessionRuntime,
    managedOpenCode,
    close,
  };
}
