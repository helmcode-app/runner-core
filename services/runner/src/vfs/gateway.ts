import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { authorize } from "../http/index.js";
import { VfsBridge } from "./bridge.js";
import { JsonRpcCode, VfsMethod } from "./protocol.js";

export interface VfsGateway {
  bridge: VfsBridge | null;
  close(): Promise<void>;
}

const WS_PATH = "/v1/vfs";

/** Start the helm-vfs child process (no WebSocket yet). */
export async function startVfsBridge(
  config: AppConfig,
  logger: Logger,
): Promise<VfsBridge | null> {
  const log = logger.child({ component: "vfs-gateway" });
  if (!config.VFS_ENABLED) {
    log.info("VFS disabled (VFS_ENABLED=false)");
    return null;
  }

  const bridge = new VfsBridge({
    root: config.MAIN_REPO_PATH,
    logger,
    ...(config.HELM_VFS_BIN !== undefined
      ? { binaryPath: config.HELM_VFS_BIN }
      : {}),
  });

  try {
    await bridge.start();
    return bridge;
  } catch (err) {
    log.error("failed to start helm-vfs", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Attach WebSocket VFS gateway on `/v1/vfs`.
 * Client messages are JSON-RPC forwarded to helm-vfs; responses and
 * `vfs/didChange` notifications are pushed on the same socket.
 */
export function attachVfsWebSocket(
  server: Server,
  bridge: VfsBridge,
  config: AppConfig,
  logger: Logger,
): { close(): Promise<void> } {
  const log = logger.child({ component: "vfs-ws" });
  const apiToken = config.OPENCORE_API_TOKEN?.trim() || undefined;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const onDidChange = (params: unknown): void => {
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: VfsMethod.DidChange,
      params,
    });
    let sent = 0;
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(note);
        sent += 1;
      }
    }
    log.info("broadcast vfs/didChange", {
      clients: sockets.size,
      sent,
      params,
    });
  };
  bridge.on("didChange", onDidChange);

  const onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== WS_PATH) {
      return;
    }
    if (!authorize(req, apiToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    log.info("vfs websocket connected", { clients: sockets.size });

    ws.on("message", (data) => {
      void handleWsMessage(ws, bridge, data);
    });

    ws.on("close", () => {
      sockets.delete(ws);
      log.info("vfs websocket disconnected", { clients: sockets.size });
    });
  });

  return {
    close: async () => {
      bridge.off("didChange", onDidChange);
      server.off("upgrade", onUpgrade);
      for (const ws of sockets) ws.close();
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
): Promise<VfsGateway> {
  const bridge = await startVfsBridge(config, logger);
  if (!bridge) {
    return { bridge: null, close: async () => undefined };
  }
  const ws = attachVfsWebSocket(server, bridge, config, logger);
  return {
    bridge,
    close: async () => {
      await ws.close();
      await bridge.stop();
    },
  };
}
