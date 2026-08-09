/**
 * Backend-agnostic agent session API (open-core).
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
 * Adapter today: local OpenCode Server (implementation detail).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import { readJson, sendJson } from "../http/index.js";
import type { Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { submitPromptAsync } from "../opencode/prompt.js";
import type { ManagedOpenCodeRuntime } from "../opencode/runtime.js";
import { sendSessionError } from "./errors.js";
import { mapHistoryToTimeline, mapSession, mapSessionList } from "./mapper.js";
import { mapProviderCatalog } from "./models.js";
import { proxySessionEvents } from "./sse.js";
import type {
  CreateSessionRequest,
  PromptRequest,
  RevertSessionRequest,
  SessionHistoryResponse,
} from "./types.js";

export interface SessionRouteContext {
  config: AppConfig;
  /** Active runtime client; null when sessions feature is off. */
  client: OpenCodeClient | null;
  /** Present when OPENCODE_MANAGED (install at boot + periodic update). */
  managedOpenCode?: ManagedOpenCodeRuntime | null;
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

  if (!ctx.config.OPENCODE_ENABLED) {
    sendJson(res, 503, {
      error: "Agent sessions disabled (set OPENCODE_ENABLED=true)",
    });
    return true;
  }

  if (!ctx.client) {
    sendJson(res, 503, { error: "Agent session runtime not configured" });
    return true;
  }

  const client = ctx.client;
  const log = ctx.logger.child({ component: "sessions" });

  try {
    if (method === "GET" && pathname === "/v1/sessions/health") {
      return await handleHealth(res, client, ctx);
    }

    if (method === "GET" && pathname === "/v1/sessions/models") {
      return await handleModels(res, client);
    }

    if (method === "GET" && pathname === "/v1/sessions/events") {
      await proxySessionEvents(client, req, res, log);
      return true;
    }

    if (method === "POST" && pathname === "/v1/sessions") {
      return await handleCreate(req, res, client, log);
    }

    if (method === "GET" && pathname === "/v1/sessions") {
      const raw = await client.listSessions();
      sendJson(res, 200, { sessions: mapSessionList(raw) });
      return true;
    }

    const m = pathname.match(SESSION_ID_ACTION);
    if (!m) {
      sendJson(res, 404, { error: "session route not found" });
      return true;
    }

    const sessionId = decodeURIComponent(m[1] ?? "");
    const action = m[2];

    if (method === "GET" && !action) {
      const raw = await client.getSession(sessionId);
      sendJson(res, 200, { session: mapSession(raw) });
      return true;
    }

    if (method === "DELETE" && !action) {
      await client.deleteSession(sessionId);
      sendJson(res, 200, { sessionId, deleted: true });
      return true;
    }

    if (method === "POST" && action === "prompt") {
      return await handlePrompt(req, res, client, ctx, log, sessionId);
    }

    if (method === "GET" && action === "history") {
      return await handleHistory(req, res, client, log, sessionId);
    }

    if (method === "POST" && action === "abort") {
      const result = await client.abortSession(sessionId);
      const aborted =
        result === true ||
        result === undefined ||
        (typeof result === "object" && result !== null);
      sendJson(res, 200, { sessionId, aborted: Boolean(aborted) });
      return true;
    }

    if (method === "POST" && action === "revert") {
      return await handleRevert(req, res, client, log, sessionId);
    }

    if (method === "POST" && action === "unrevert") {
      log.info("session unrevert", { sessionId });
      const raw = await client.unrevertSession(sessionId);
      sendJson(res, 200, {
        sessionId,
        unreverted: true,
        session: mapSession(raw),
      });
      return true;
    }

    if (method === "GET" && action === "diff") {
      return await handleDiff(req, res, client, sessionId);
    }

    sendJson(res, 404, { error: "session route not found" });
    return true;
  } catch (err) {
    return sendSessionError(res, err, log);
  }
}

// ── Handlers ─────────────────────────────────────────────────

async function handleHealth(
  res: ServerResponse,
  client: OpenCodeClient,
  ctx: SessionRouteContext,
): Promise<true> {
  const managed = ctx.managedOpenCode?.status;
  try {
    const h = await client.health();
    sendJson(res, 200, {
      ok: h.healthy,
      provider: "session-runtime",
      ...(h.version !== undefined ? { version: h.version } : {}),
      ...(managed !== undefined ? { managed } : { managed: false }),
    });
  } catch (err) {
    sendJson(res, 502, {
      ok: false,
      provider: "session-runtime",
      error: err instanceof Error ? err.message : String(err),
      ...(managed !== undefined ? { managed } : { managed: false }),
    });
  }
  return true;
}

async function handleModels(
  res: ServerResponse,
  client: OpenCodeClient,
): Promise<true> {
  try {
    const raw = await client.listProviders();
    sendJson(res, 200, mapProviderCatalog(raw));
  } catch (err) {
    sendJson(res, 502, {
      error: err instanceof Error ? err.message : String(err),
      models: [],
      connected: [],
    });
  }
  return true;
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  client: OpenCodeClient,
  log: Logger,
): Promise<true> {
  const body = (await readJson(req).catch(() => ({}))) as CreateSessionRequest;
  const raw = await client.createSession({
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.parentId !== undefined ? { parentID: body.parentId } : {}),
  });
  const session = mapSession(raw);
  log.info("session created", { sessionId: session.id });
  sendJson(res, 201, { session });
  return true;
}

async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  client: OpenCodeClient,
  ctx: SessionRouteContext,
  log: Logger,
  sessionId: string,
): Promise<true> {
  const body = (await readJson(req)) as PromptRequest;
  log.info("session prompt", {
    sessionId,
    mode: body.mode ?? "agent",
    model: body.model ?? ctx.config.OPENCODE_DEFAULT_MODEL,
    promptLen: body.prompt?.length ?? 0,
  });
  const accepted = await submitPromptAsync(client, ctx.config, sessionId, {
    prompt: body.prompt,
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(body.contextPaths !== undefined
      ? { contextPaths: body.contextPaths }
      : {}),
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.messageId !== undefined ? { messageID: body.messageId } : {}),
  });
  log.info("session prompt accepted", {
    sessionId: accepted.sessionId,
    mode: accepted.mode,
    model: accepted.model,
  });
  // Public response never includes vendor `upstream` field.
  sendJson(res, 202, {
    sessionId: accepted.sessionId,
    status: accepted.status,
    mode: accepted.mode,
    ...(accepted.model !== undefined ? { model: accepted.model } : {}),
  });
  return true;
}

async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  client: OpenCodeClient,
  log: Logger,
  sessionId: string,
): Promise<true> {
  const url = requestUrl(req);
  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw != null && limitRaw !== ""
      ? Number.parseInt(limitRaw, 10)
      : undefined;

  const [messages, sessionRaw] = await Promise.all([
    client.listMessages(sessionId, {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    }),
    client.getSession(sessionId).catch(() => undefined),
  ]);

  const entries = mapHistoryToTimeline(messages);
  if (entries.length === 0) {
    log.debug("session history empty", {
      sessionId,
      rawType: Array.isArray(messages) ? "array" : typeof messages,
      rawLen: Array.isArray(messages) ? messages.length : undefined,
    });
  }

  const payload: SessionHistoryResponse = {
    sessionId,
    entries,
    ...(sessionRaw !== undefined ? { session: mapSession(sessionRaw) } : {}),
  };
  sendJson(res, 200, payload);
  return true;
}

async function handleRevert(
  req: IncomingMessage,
  res: ServerResponse,
  client: OpenCodeClient,
  log: Logger,
  sessionId: string,
): Promise<true> {
  const body = (await readJson(req).catch(() => ({}))) as RevertSessionRequest;
  const messageID = (body.messageId ?? body.messageID ?? "").trim();
  if (!messageID) {
    sendJson(res, 400, { error: "messageId is required" });
    return true;
  }
  const partID = (body.partId ?? body.partID)?.trim();
  log.info("session revert", { sessionId, messageID });
  const raw = await client.revertSession(sessionId, {
    messageID,
    ...(partID ? { partID } : {}),
  });
  sendJson(res, 200, {
    sessionId,
    reverted: true,
    session: mapSession(raw),
  });
  return true;
}

async function handleDiff(
  req: IncomingMessage,
  res: ServerResponse,
  client: OpenCodeClient,
  sessionId: string,
): Promise<true> {
  const url = requestUrl(req);
  const messageID =
    url.searchParams.get("messageId") ??
    url.searchParams.get("messageID") ??
    undefined;
  const raw = await client.sessionDiff(sessionId, {
    ...(messageID ? { messageID } : {}),
  });
  sendJson(res, 200, {
    sessionId,
    diffs: Array.isArray(raw) ? raw : [],
  });
  return true;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}
