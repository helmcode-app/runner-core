/**
 * Session HTTP handlers (health, models, CRUD, prompt, history, cancel, rewind).
 * Dispatch lives in `routes.ts`. Backend: Agent Gateway (ACP).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentGateway } from "../agent/gateway.js";
import type { AppConfig } from "../config.js";
import { readJson, sendJson } from "../http/index.js";
import type { Logger } from "../logger.js";
import type {
  CreateSessionRequest,
  PromptRequest,
  RewindRequest,
  SessionHistoryResponse,
} from "./types.js";

export interface SessionHandlerContext {
  config: AppConfig;
  gateway: AgentGateway;
  logger: Logger;
}

export async function handleHealth(
  res: ServerResponse,
  ctx: SessionHandlerContext,
): Promise<true> {
  const h = ctx.gateway.health();
  sendJson(res, h.ok ? 200 : 502, h);
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
    const mapped = await ctx.gateway.models(forceRefresh);
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
  const session = await ctx.gateway.createSession({
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.workspaceId !== undefined ? { workspaceId: body.workspaceId } : {}),
  });
  ctx.logger.info("session created", { sessionId: session.id });
  sendJson(res, 201, { session });
  return true;
}

export async function handleList(
  res: ServerResponse,
  ctx: SessionHandlerContext,
): Promise<true> {
  sendJson(res, 200, { sessions: ctx.gateway.listSessions() });
  return true;
}

export async function handleGet(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  sendJson(res, 200, { session: ctx.gateway.getSession(sessionId) });
  return true;
}

export async function handleDelete(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  await ctx.gateway.deleteSession(sessionId);
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
    model: body.model ?? ctx.config.AGENT_DEFAULT_MODEL,
    thinkLevel: body.thinkLevel,
    fast: body.fast,
    promptLen: body.prompt?.length ?? 0,
  });
  const accepted = await ctx.gateway.submitPrompt(sessionId, body);
  ctx.logger.info("session prompt accepted", {
    sessionId: accepted.sessionId,
    mode: accepted.mode,
    model: accepted.model,
  });
  sendJson(res, 202, accepted);
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

  const hist = ctx.gateway.history(
    sessionId,
    limit !== undefined && Number.isFinite(limit) ? limit : undefined,
  );
  const payload: SessionHistoryResponse = {
    sessionId: hist.sessionId,
    entries: hist.entries,
    session: hist.session,
    ...(hist.usage !== undefined ? { usage: hist.usage } : {}),
  };
  sendJson(res, 200, payload);
  return true;
}

export async function handleCancel(
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const cancelled = await ctx.gateway.cancel(sessionId);
  sendJson(res, 200, { sessionId, cancelled });
  return true;
}

export async function handleRewind(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SessionHandlerContext,
  sessionId: string,
): Promise<true> {
  const body = (await readJson(req).catch(() => ({}))) as RewindRequest;
  const result = await ctx.gateway.rewind(sessionId, {
    messageId: body.messageId ?? "",
    restore: body.restore,
  });
  ctx.logger.info("session rewind", {
    sessionId: result.sessionId,
    messageId: result.messageId,
    restore: result.restore,
    truncated: result.truncated,
    filesRestored: result.filesRestored,
  });
  sendJson(res, 200, result);
  return true;
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}
