import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentGateway } from "../../agent/gateway.js";
import type { AppConfig } from "../../config.js";
import { readJson, sendJson } from "../../http/index.js";
import type { Logger } from "../../logger.js";
import { handleSessionHttp } from "../../sessions/index.js";
import type { HealthStatus } from "../../types.js";
import { handleVfsHttp } from "../../vfs/index.js";
import type { VfsBridge } from "../../vfs/index.js";
import {
  handleWorkspaceHttp,
  type WorkspaceRegistry,
} from "../../workspaces/index.js";
import { handleSetupHttp, type SetupController } from "../../setup/index.js";

export interface OpenCoreRouteContext {
  config: AppConfig;
  getBridge: (workspaceId?: string | null) => VfsBridge | null;
  workspaces: WorkspaceRegistry;
  /** ACP agent gateway when sessions are enabled. */
  agentGateway: AgentGateway | null;
  setup: SetupController;
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
      sessionsEnabled: Boolean(ctx.agentGateway),
    };
    sendJson(res, 200, body);
    return;
  }

  if (await handleSetupHttp(req, res, method, url, ctx.setup)) {
    return;
  }

  if (!ctx.setup.authorizeDevice(req)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (method === "GET" && url.pathname === "/v1/status") {
    const setup = ctx.setup.operatorStatus();
    sendJson(res, 200, {
      mode: ctx.config.mode,
      version: ctx.config.version,
      sessionsEnabled: Boolean(ctx.agentGateway),
      agentHarness: ctx.config.SESSIONS_ENABLED
        ? ctx.config.AGENT_HARNESS
        : undefined,
      agentTransport: ctx.config.SESSIONS_ENABLED ? "stdio" : undefined,
      sessionsManaged: Boolean(ctx.agentGateway),
      authRequired: true,
      runnerId: await ctx.setup.runnerId(),
      vfsEnabled: ctx.config.VFS_ENABLED,
      terminalEnabled: ctx.config.TERMINAL_ENABLED,
      defaultWorkspaceId: ctx.workspaces.defaultId(),
      setupPhase: setup.phase,
    });
    return;
  }

  if (
    await handleWorkspaceHttp(req, res, method, url.pathname, {
      workspaces: ctx.workspaces,
    })
  ) {
    return;
  }

  if (
    await handleVfsHttp(
      req,
      res,
      method,
      url.pathname,
      {
        config: ctx.config,
        workspaces: ctx.workspaces,
        getBridge: ctx.getBridge,
        sendJson,
        readJson,
      },
      url.searchParams,
    )
  ) {
    return;
  }

  if (
    await handleSessionHttp(req, res, method, url.pathname, {
      config: ctx.config,
      gateway: ctx.agentGateway,
      logger: ctx.logger,
    })
  ) {
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
