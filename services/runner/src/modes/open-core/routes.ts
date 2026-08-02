import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentPipeline } from "../../agent/index.js";
import type { AppConfig } from "../../config.js";
import { authorize, readJson, sendJson } from "../../http/index.js";
import type { HealthStatus, OpenCoreSubmitBody } from "../../types.js";
import { handleVfsHttp } from "../../vfs/index.js";
import type { VfsBridge } from "../../vfs/index.js";
import { httpStatusForResult, type TaskStore } from "./task-store.js";

export interface OpenCoreRouteContext {
  config: AppConfig;
  agent: AgentPipeline;
  store: TaskStore;
  apiToken: string | undefined;
  getBridge: () => VfsBridge | null;
}

/**
 * Dispatch a single HTTP request for open-core.
 * Returns true when handled (including 404 for unmatched paths).
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
      activeTasks: ctx.agent.activeTaskCount,
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
      activeTasks: ctx.agent.activeTaskCount,
      knownTasks: ctx.store.size,
      authRequired: Boolean(ctx.apiToken),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/tasks") {
    const body = (await readJson(req)) as OpenCoreSubmitBody;
    const out = ctx.store.submitAsync(ctx.agent, body);
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
    const out = ctx.store.cancel(ctx.agent, id);
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
    const rec = ctx.store.get(id);
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
    const out = await ctx.store.submitSync(ctx.agent, body);
    if (!out.ok) {
      sendJson(res, out.status, { error: out.error });
      return;
    }
    sendJson(res, httpStatusForResult(out.result.status), out.result);
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

  sendJson(res, 404, { error: "not found" });
}
