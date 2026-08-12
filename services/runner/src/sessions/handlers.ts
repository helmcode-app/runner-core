/**
 * Session HTTP handlers (health, models, CRUD, prompt, history, revert, diff).
 * Dispatch lives in `routes.ts`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import { readJson, sendJson } from "../http/index.js";
import type { Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { submitPromptAsync } from "../opencode/prompt.js";
import type { ManagedOpenCodeRuntime } from "../opencode/runtime.js";
import { mapHistoryToTimeline, mapSession, mapSessionList } from "./mapper.js";
import { loadSessionModelsCatalog } from "./models.js";
import type {
  CreateSessionRequest,
  PromptRequest,
  RevertSessionRequest,
  SessionHistoryResponse,
} from "./types.js";

export interface SessionHandlerContext {
  config: AppConfig;
  client: OpenCodeClient;
  managedOpenCode?: ManagedOpenCodeRuntime | null;
  logger: Logger;
}

export async function handleHealth(
  res: ServerResponse,
  ctx: SessionHandlerContext,
): Promise<true> {
  const managed = ctx.managedOpenCode?.status;
  try {
    const h = await ctx.client.health();
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

export async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
): Promise<true> {
  try {
    const url = requestUrl(req);
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const mapped = await loadSessionModelsCatalog(ctx.client, ctx.config, {
      forceRefresh,
    });
    sendJson(res, 200, mapped);
  } catch (err) {
    sendJson(res, 502, {
      error: err instanceof Error ? err.message : String(err),
      models: [],
      connected: [],
    });
  }
  return true;
}

export async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
): Promise<true> {
  const body = (await readJson(req).catch(() => ({}))) as CreateSessionRequest;
  const raw = await ctx.client.createSession({
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.parentId !== undefined ? { parentID: body.parentId } : {}),
  });
  const session = mapSession(raw);
  ctx.logger.info("session created", { sessionId: session.id });
  sendJson(res, 201, { session });
  return true;
}

export async function handleList(
  res: ServerResponse,
  ctx: SessionHandlerContext,
): Promise<true> {
  const raw = await ctx.client.listSessions();
  sendJson(res, 200, { sessions: mapSessionList(raw) });
  return true;
}

export async function handleGet(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const raw = await ctx.client.getSession(sessionId);
  sendJson(res, 200, { session: mapSession(raw) });
  return true;
}

export async function handleDelete(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  await ctx.client.deleteSession(sessionId);
  sendJson(res, 200, { sessionId, deleted: true });
  return true;
}

export async function handlePrompt(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const body = (await readJson(req)) as PromptRequest;
  ctx.logger.info("session prompt", {
    sessionId,
    mode: body.mode ?? "agent",
    model: body.model ?? ctx.config.OPENCODE_DEFAULT_MODEL,
    promptLen: body.prompt?.length ?? 0,
  });
  const accepted = await submitPromptAsync(ctx.client, ctx.config, sessionId, {
    prompt: body.prompt,
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(body.contextPaths !== undefined
      ? { contextPaths: body.contextPaths }
      : {}),
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.messageId !== undefined ? { messageID: body.messageId } : {}),
  });
  ctx.logger.info("session prompt accepted", {
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

export async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const url = requestUrl(req);
  const limitRaw = url.searchParams.get("limit");
  const limit =
    limitRaw != null && limitRaw !== ""
      ? Number.parseInt(limitRaw, 10)
      : undefined;

  const [messages, sessionRaw] = await Promise.all([
    ctx.client.listMessages(sessionId, {
      ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
    }),
    ctx.client.getSession(sessionId).catch(() => undefined),
  ]);

  const entries = mapHistoryToTimeline(messages);
  if (entries.length === 0) {
    ctx.logger.debug("session history empty", {
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

export async function handleAbort(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const result = await ctx.client.abortSession(sessionId);
  const aborted =
    result === true ||
    result === undefined ||
    (typeof result === "object" && result !== null);
  sendJson(res, 200, { sessionId, aborted: Boolean(aborted) });
  return true;
}

export async function handleRevert(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const body = (await readJson(req).catch(() => ({}))) as RevertSessionRequest;
  const messageID = (body.messageId ?? body.messageID ?? "").trim();
  if (!messageID) {
    sendJson(res, 400, { error: "messageId is required" });
    return true;
  }
  const partID = (body.partId ?? body.partID)?.trim();
  ctx.logger.info("session revert", { sessionId, messageID });
  const raw = await ctx.client.revertSession(sessionId, {
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

export async function handleUnrevert(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  ctx.logger.info("session unrevert", { sessionId });
  const raw = await ctx.client.unrevertSession(sessionId);
  sendJson(res, 200, {
    sessionId,
    unreverted: true,
    session: mapSession(raw),
  });
  return true;
}

export async function handleDiff(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const url = requestUrl(req);
  const messageID =
    url.searchParams.get("messageId") ??
    url.searchParams.get("messageID") ??
    undefined;
  const raw = await ctx.client.sessionDiff(sessionId, {
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
