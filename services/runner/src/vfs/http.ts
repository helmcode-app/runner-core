import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { VfsBridge } from "./bridge.js";
import { JsonRpcCode } from "./protocol.js";

export interface VfsHttpContext {
  config: AppConfig;
  bridge: VfsBridge | null;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

/**
 * Handle HTTP VFS routes. Returns true if the request was consumed.
 *
 * - POST /v1/vfs/rpc  — single JSON-RPC request/response
 * - GET  /v1/vfs/status
 */
export async function handleVfsHttp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  ctx: VfsHttpContext,
): Promise<boolean> {
  if (method === "POST" && pathname === "/v1/vfs/rpc") {
    if (!ctx.bridge) {
      ctx.sendJson(res, 503, { error: "vfs unavailable" });
      return true;
    }
    const body = await ctx.readJson(req);
    const id = extractId(body);
    try {
      const result = await ctx.bridge.forward(body);
      ctx.sendJson(res, 200, {
        jsonrpc: "2.0",
        id: id ?? null,
        result,
      });
    } catch (err) {
      ctx.sendJson(res, 200, {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: JsonRpcCode.ServerError,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return true;
  }

  if (method === "GET" && pathname === "/v1/vfs/status") {
    ctx.sendJson(res, 200, {
      enabled: ctx.config.VFS_ENABLED,
      running: Boolean(ctx.bridge?.isRunning),
      root: ctx.config.MAIN_REPO_PATH,
      ws: "/v1/vfs",
      rpc: "/v1/vfs/rpc",
    });
    return true;
  }

  return false;
}

function extractId(body: unknown): unknown {
  if (body && typeof body === "object" && "id" in body) {
    return (body as { id?: unknown }).id;
  }
  return undefined;
}
