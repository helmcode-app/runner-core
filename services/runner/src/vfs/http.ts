import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import {
  parseWorkspaceId,
  WorkspaceNotFoundError,
  type WorkspaceRegistry,
} from "../workspaces/index.js";
import type { VfsBridge } from "./bridge.js";
import { JsonRpcCode } from "./protocol.js";

export interface VfsHttpContext {
  config: AppConfig;
  workspaces: WorkspaceRegistry;
  getBridge: (workspaceId?: string | null) => VfsBridge | null;
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
  searchParams?: URLSearchParams,
): Promise<boolean> {
  const workspaceId = parseWorkspaceId(searchParams?.get("workspaceId"));

  if (method === "POST" && pathname === "/v1/vfs/rpc") {
    let bridge: VfsBridge | null;
    try {
      ctx.workspaces.get(workspaceId);
      bridge = ctx.getBridge(workspaceId);
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) {
        ctx.sendJson(res, 404, { error: err.message });
        return true;
      }
      throw err;
    }
    if (!bridge) {
      ctx.sendJson(res, 503, { error: "vfs unavailable" });
      return true;
    }
    const body = await ctx.readJson(req);
    const id = extractId(body);
    try {
      const result = await bridge.forward(body);
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
    let workspace;
    try {
      workspace = ctx.workspaces.get(workspaceId);
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) {
        ctx.sendJson(res, 404, { error: err.message });
        return true;
      }
      throw err;
    }
    ctx.sendJson(res, 200, {
      enabled: ctx.config.VFS_ENABLED,
      running: Boolean(ctx.getBridge(workspaceId)?.isRunning),
      workspaceId: workspace.id,
      root: workspace.path,
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
