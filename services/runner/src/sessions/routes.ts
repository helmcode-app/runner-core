/**
 * Backend-agnostic agent session API (open-core) — HTTP dispatch only.
 *
 *   GET    /v1/sessions/health
 *   GET    /v1/sessions/models
 *   GET    /v1/sessions/events          SSE
 *   POST   /v1/sessions
 *   GET    /v1/sessions
 *   GET    /v1/sessions/:id
 *   DELETE /v1/sessions/:id
 *   POST   /v1/sessions/:id/prompt
 *   GET    /v1/sessions/:id/history
 *   POST   /v1/sessions/:id/abort
 *   POST   /v1/sessions/:id/revert
 *   POST   /v1/sessions/:id/unrevert
 *   GET    /v1/sessions/:id/diff
 *
 * Handlers: `./handlers.ts`. Runtime: Agent Gateway (ACP Client).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentGateway } from "../agent/gateway.js";
import type { AppConfig } from "../config.js";
import { sendJson } from "../http/index.js";
import type { Logger } from "../logger.js";
import { sendSessionError } from "./errors.js";
import {
  handleAbort,
  handleCreate,
  handleDelete,
  handleDiff,
  handleGet,
  handleHealth,
  handleHistory,
  handleList,
  handleModels,
  handlePrompt,
  handleRevert,
  handleUnrevert,
  type SessionHandlerContext,
} from "./handlers.js";
import { proxySessionEvents } from "./sse.js";

export interface SessionRouteContext {
  config: AppConfig;
  /** Agent gateway when sessions are enabled. */
  gateway: AgentGateway | null;
  logger: Logger;
}

const SESSION_ID_ACTION =
  /^\/v1\/sessions\/([^/]+)(?:\/(prompt|history|abort|revert|unrevert|diff))?$/;

/**
 * Handle `/v1/sessions/*`. Returns true if the path was claimed.
 */
export async function handleSessionHttp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  ctx: SessionRouteContext,
): Promise<boolean> {
  if (!pathname.startsWith("/v1/sessions")) return false;

  if (!ctx.config.SESSIONS_ENABLED) {
    sendJson(res, 503, {
      error: "Agent sessions disabled (set SESSIONS_ENABLED=true)",
    });
    return true;
  }

  if (!ctx.gateway) {
    sendJson(res, 503, { error: "Agent session runtime not configured" });
    return true;
  }

  const log = ctx.logger.child({ component: "sessions" });
  const hctx: SessionHandlerContext = {
    config: ctx.config,
    gateway: ctx.gateway,
    logger: log,
  };

  try {
    if (method === "GET" && pathname === "/v1/sessions/health") {
      return await handleHealth(res, hctx);
    }

    if (method === "GET" && pathname === "/v1/sessions/models") {
      return await handleModels(req, res, hctx);
    }

    if (method === "GET" && pathname === "/v1/sessions/events") {
      await proxySessionEvents(ctx.gateway, req, res, log);
      return true;
    }

    if (method === "POST" && pathname === "/v1/sessions") {
      return await handleCreate(req, res, hctx);
    }

    if (method === "GET" && pathname === "/v1/sessions") {
      return await handleList(res, hctx);
    }

    const m = pathname.match(SESSION_ID_ACTION);
    if (!m) {
      sendJson(res, 404, { error: "session route not found" });
      return true;
    }

    const sessionId = decodeURIComponent(m[1] ?? "");
    const action = m[2];

    if (method === "GET" && !action) {
      return await handleGet(res, hctx, sessionId);
    }

    if (method === "DELETE" && !action) {
      return await handleDelete(res, hctx, sessionId);
    }

    if (method === "POST" && action === "prompt") {
      return await handlePrompt(req, res, hctx, sessionId);
    }

    if (method === "GET" && action === "history") {
      return await handleHistory(req, res, hctx, sessionId);
    }

    if (method === "POST" && action === "abort") {
      return await handleAbort(res, hctx, sessionId);
    }

    if (method === "POST" && action === "revert") {
      return await handleRevert(req, res, hctx, sessionId);
    }

    if (method === "POST" && action === "unrevert") {
      return await handleUnrevert(res, hctx, sessionId);
    }

    if (method === "GET" && action === "diff") {
      return await handleDiff(req, res, hctx, sessionId);
    }

    sendJson(res, 404, { error: "session route not found" });
    return true;
  } catch (err) {
    return sendSessionError(res, err, log);
  }
}
