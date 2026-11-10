import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleAgentHttp,
  type AgentRuntimeController,
} from "../../agent/index.js";
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
  agent: AgentRuntimeController;
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
  const agentView = ctx.agent.view();
  const sessionsReady = Boolean(ctx.agent.gateway);

  if (method === "GET" && url.pathname === "/health") {
    const body: HealthStatus = {
      ok: true,
      mode: ctx.config.mode,
      version: ctx.config.version,
      uptimeMs: Math.floor(process.uptime() * 1000),
      sessionsEnabled: sessionsReady,
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
      sessionsEnabled: sessionsReady,
      agentConfigured: agentView.enabled,
      agentPhase: agentView.phase,
      agentHarness: agentView.enabled ? agentView.harness : undefined,
      agentTransport: agentView.enabled ? "stdio" : undefined,
      sessionsManaged: sessionsReady,
      authRequired: true,
      runnerId: await ctx.setup.runnerId(),
      vfsEnabled: ctx.config.VFS_ENABLED,
      terminalEnabled: ctx.config.TERMINAL_ENABLED,
      defaultWorkspaceId: ctx.workspaces.defaultId(),
      setupPhase: setup.phase,
    });
    return;
  }

  if (await handleAgentHttp(req, res, method, url.pathname, { agent: ctx.agent })) {
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
      config: ctx.agent.effectiveConfig,
      gateway: ctx.agent.gateway,
      logger: ctx.logger,
      agentPhase: agentView.phase,
    })
  ) {
    return;
  }

  sendJson(res, 404, { error: "not found" });
}
