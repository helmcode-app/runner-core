import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import { attachAuthenticatedUpgrade, closeWebSockets } from "../http/index.js";
import type { Logger } from "../logger.js";
import {
  DEFAULT_WORKSPACE_ID,
  parseWorkspaceId,
  WorkspaceNotFoundError,
  type WorkspaceRegistry,
} from "../workspaces/index.js";
import { VfsBridge } from "./bridge.js";
import { VfsBridgePool } from "./pool.js";
import { JsonRpcCode, VfsMethod } from "./protocol.js";

export const VFS_WS_PATH = "/v1/vfs";

export interface VfsGateway {
  /** Default-workspace bridge (boot-time). */
  bridge: VfsBridge | null;
  pool: VfsBridgePool | null;
  getBridge(workspaceId?: string | null): VfsBridge | null;
  close(): Promise<void>;
}

/**
 * Attach WebSocket VFS gateway on `/v1/vfs`.
 * `?workspaceId=` selects the helm-vfs process (default `default`).
 */
export function attachVfsWebSocket(
  server: Server,
  pool: VfsBridgePool,
  config: AppConfig,
  logger: Logger,
  authorize: (req: IncomingMessage, url: URL) => boolean,
): { close(): Promise<void> } {
  const log = logger.child({ component: "vfs-ws" });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<WebSocket, { workspaceId: string }>();

  const onDidChange = (workspaceId: string, params: unknown): void => {
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: VfsMethod.DidChange,
      params,
    });
    let sent = 0;
    for (const [ws, meta] of sockets) {
      if (meta.workspaceId !== workspaceId) continue;
      if (ws.readyState === ws.OPEN) {
        ws.send(note);
        sent += 1;
      }
    }
    log.info("broadcast vfs/didChange", {
      workspaceId,
      clients: sockets.size,
      sent,
      params,
    });
  };

  const changeHandlers = new Map<string, (params: unknown) => void>();

  const watchBridge = (workspaceId: string, bridge: VfsBridge): void => {
    if (changeHandlers.has(workspaceId)) return;
    const handler = (params: unknown): void => onDidChange(workspaceId, params);
    changeHandlers.set(workspaceId, handler);
    bridge.on("didChange", handler);
  };

  const defaultBridge = pool.get(DEFAULT_WORKSPACE_ID);
  if (defaultBridge) watchBridge(DEFAULT_WORKSPACE_ID, defaultBridge);

  const onUpgrade = attachAuthenticatedUpgrade(server, {
    path: VFS_WS_PATH,
    wss,
    authorize,
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, url: URL) => {
    const workspaceId = parseWorkspaceId(url.searchParams.get("workspaceId"));
    void (async () => {
      try {
        const bridge = await pool.ensure(workspaceId);
        if (!bridge) {
          ws.close(1013, "vfs unavailable");
          return;
        }
        watchBridge(workspaceId, bridge);
        sockets.set(ws, { workspaceId });
        log.info("vfs websocket connected", {
          workspaceId,
          clients: sockets.size,
        });

        ws.on("message", (data) => {
          void handleWsMessage(ws, bridge, data);
        });
        ws.on("close", () => {
          sockets.delete(ws);
          log.info("vfs websocket disconnected", {
            workspaceId,
            clients: sockets.size,
          });
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("vfs websocket rejected", { workspaceId, error: message });
        const code = err instanceof WorkspaceNotFoundError ? 1008 : 1011;
        try {
          ws.close(code, message.slice(0, 120));
        } catch {
          /* ignore */
        }
      }
    })();
  });

  return {
    close: async () => {
      for (const [workspaceId, handler] of changeHandlers) {
        pool.get(workspaceId)?.off("didChange", handler);
      }
      changeHandlers.clear();
      server.off("upgrade", onUpgrade);
      closeWebSockets(sockets.keys());
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

async function handleWsMessage(
  ws: WebSocket,
  bridge: VfsBridge,
  data: WebSocket.RawData,
): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcCode.ParseError,
          message: "parse error",
        },
      }),
    );
    return;
  }

  const id =
    msg && typeof msg === "object" && "id" in msg
      ? (msg as { id?: string | number | null }).id
      : undefined;

  try {
    const result = await bridge.forward(msg);
    if (id === undefined || id === null) return;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  } catch (err) {
    if (id === undefined || id === null) return;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: JsonRpcCode.ServerError,
          message: err instanceof Error ? err.message : String(err),
        },
      }),
    );
  }
}

export async function createVfsGateway(
  server: Server,
  config: AppConfig,
  logger: Logger,
  workspaces: WorkspaceRegistry,
  authorize: (req: IncomingMessage, url: URL) => boolean,
): Promise<VfsGateway> {
  if (!config.VFS_ENABLED) {
    logger
      .child({ component: "vfs-gateway" })
      .info("VFS disabled (VFS_ENABLED=false)");
    return {
      bridge: null,
      pool: null,
      getBridge: () => null,
      close: async () => undefined,
    };
  }

  const pool = new VfsBridgePool(config, logger, workspaces);
  try {
    await pool.ensure(DEFAULT_WORKSPACE_ID);
  } catch (err) {
    logger
      .child({ component: "vfs-gateway" })
      .error("failed to start helm-vfs", {
        error: err instanceof Error ? err.message : String(err),
      });
    return {
      bridge: null,
      pool: null,
      getBridge: () => null,
      close: async () => undefined,
    };
  }

  const ws = attachVfsWebSocket(server, pool, config, logger, authorize);
  return {
    get bridge() {
      return pool.get(DEFAULT_WORKSPACE_ID);
    },
    pool,
    getBridge: (workspaceId) => pool.get(parseWorkspaceId(workspaceId)),
    close: async () => {
      await ws.close();
      await pool.close();
    },
  };
}
