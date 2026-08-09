import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../../config.js";
import { authorize, readJson, sendJson } from "../../http/index.js";
import type { Logger } from "../../logger.js";
import type {
  ManagedOpenCodeRuntime,
  OpenCodeClient,
} from "../../opencode/index.js";
import { handleSessionHttp } from "../../sessions/index.js";
import type { HealthStatus } from "../../types.js";
import { handleVfsHttp } from "../../vfs/index.js";
import type { VfsBridge } from "../../vfs/index.js";

export interface OpenCoreRouteContext {
  config: AppConfig;
  apiToken: string | undefined;
  getBridge: () => VfsBridge | null;
  /** Session runtime client when agent sessions are enabled. */
  sessionRuntime: OpenCodeClient | null;
  /** Local OpenCode install/serve supervisor when OPENCODE_MANAGED. */
  managedOpenCode?: ManagedOpenCodeRuntime | null;
  logger: Logger;
}

/**
 * Dispatch a single HTTP request for open-core.
 */
export async function handleOpenCoreRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: OpenCoreRouteContext,
): Promise<void> {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" && url.pathname === "/health") {
    const body: HealthStatus = {
      ok: true,
      mode: ctx.config.mode,
      version: ctx.config.version,
      uptimeMs: Math.floor(process.uptime() * 1000),
      sessionsEnabled: Boolean(ctx.sessionRuntime),
    };
    sendJson(res, 200, body);
    return;
  }

  if (!authorize(req, ctx.apiToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/status") {
    sendJson(res, 200, {
      mode: ctx.config.mode,
      version: ctx.config.version,
      sessionsEnabled: Boolean(ctx.sessionRuntime),
      sessionsManaged: Boolean(ctx.managedOpenCode),
      authRequired: Boolean(ctx.apiToken),
      vfsEnabled: ctx.config.VFS_ENABLED,
      terminalEnabled: ctx.config.TERMINAL_ENABLED,
    });
    return;
  }

  if (
    await handleVfsHttp(req, res, method, url.pathname, {
      config: ctx.config,
      bridge: ctx.getBridge(),
      sendJson,
      readJson,
    })
  ) {
    return;
  }

  if (
    await handleSessionHttp(req, res, method, url.pathname, {
      config: ctx.config,
      client: ctx.sessionRuntime,
      managedOpenCode: ctx.managedOpenCode ?? null,
      logger: ctx.logger,
    })
  ) {
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
