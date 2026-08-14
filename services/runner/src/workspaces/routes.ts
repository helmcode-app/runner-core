/**
 *   GET /v1/workspaces
 *   GET /v1/workspaces/:id
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../http/index.js";
import { WorkspaceNotFoundError } from "./types.js";
import type { WorkspaceRegistry } from "./registry.js";

export interface WorkspaceRouteContext {
  workspaces: WorkspaceRegistry;
}

const WORKSPACE_ID = /^\/v1\/workspaces\/([^/]+)$/;

export async function handleWorkspaceHttp(
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  ctx: WorkspaceRouteContext,
): Promise<boolean> {
  if (!pathname.startsWith("/v1/workspaces")) return false;

  try {
    if (method === "GET" && pathname === "/v1/workspaces") {
      sendJson(res, 200, {
        workspaces: ctx.workspaces.list(),
        defaultWorkspaceId: ctx.workspaces.defaultId(),
      });
      return true;
    }

    const m = pathname.match(WORKSPACE_ID);
    if (method === "GET" && m) {
      const id = decodeURIComponent(m[1] ?? "");
      sendJson(res, 200, { workspace: ctx.workspaces.get(id) });
      return true;
    }

    sendJson(res, 404, { error: "workspace route not found" });
    return true;
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      sendJson(res, 404, { error: err.message });
      return true;
    }
    throw err;
  }
}
