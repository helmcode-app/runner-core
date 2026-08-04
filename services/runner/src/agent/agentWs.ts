import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import {
  attachAuthenticatedUpgrade,
  closeWebSockets,
} from "../http/index.js";
import type { Logger } from "../logger.js";
import type { JsonRpcRequest, TaskProgressEvent } from "../types.js";
import type { HelmCodeAgentEngine } from "./agentEngine.js";
import {
  AgentControllerRouter,
  AgentJsonRpcCode,
} from "./agentRouter.js";

export const AGENT_WS_PATH = "/v1/agent";

export interface AgentGateway {
  engine: HelmCodeAgentEngine;
  router: AgentControllerRouter;
  /** Broadcast a progress notification to all connected agent sockets. */
  broadcastProgress(event: TaskProgressEvent): void;
  close(): Promise<void>;
}

/**
 * JSON-RPC WebSocket gateway on `/v1/agent` (unified open-core ingress).
 *
 * Clients send `agent/run` / cancel / status and receive `agent/progress` +
 * `agent/done` notifications on the same socket.
 */
export function createAgentGateway(
  server: Server,
  engine: HelmCodeAgentEngine,
  config: AppConfig,
  logger: Logger,
): AgentGateway {
  const log = logger.child({ component: "agent-ws" });
  const apiToken = config.OPENCORE_API_TOKEN?.trim() || undefined;
  const router = new AgentControllerRouter(engine, { asyncByDefault: true });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  const broadcastProgress = (event: TaskProgressEvent): void => {
    const note = JSON.stringify({
      jsonrpc: "2.0",
      method: "agent/progress",
      params: event,
    });
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(note);
        } catch {
          /* ignore broken peer */
        }
      }
    }
  };

  const onUpgrade = attachAuthenticatedUpgrade(server, {
    path: AGENT_WS_PATH,
    wss,
    apiToken,
  });

  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    log.info("agent websocket connected", { clients: sockets.size });

    ws.on("message", (data) => {
      void handleMessage(ws, router, data, log);
    });

    ws.on("close", () => {
      sockets.delete(ws);
      log.info("agent websocket disconnected", { clients: sockets.size });
    });

    ws.on("error", (err) => {
      log.warn("agent websocket error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  return {
    engine,
    router,
    broadcastProgress,
    close: async () => {
      server.off("upgrade", onUpgrade);
      closeWebSockets(sockets);
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** @deprecated Prefer {@link createAgentGateway}. */
export const attachAgentWebSocket = createAgentGateway;

async function handleMessage(
  ws: WebSocket,
  router: AgentControllerRouter,
  data: WebSocket.RawData,
  log: Logger,
): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    send(ws, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: AgentJsonRpcCode.ParseError,
        message: "parse error",
      },
    });
    return;
  }

  if (!msg || typeof msg !== "object") {
    send(ws, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: AgentJsonRpcCode.InvalidRequest,
        message: "invalid request",
      },
    });
    return;
  }

  const request = msg as JsonRpcRequest;
  const id = "id" in request ? (request.id ?? null) : null;

  try {
    const response = await router.handle(request, (method, params) => {
      send(ws, { jsonrpc: "2.0", method, params });
    });
    if (response) send(ws, response);
  } catch (err) {
    log.error("agent router failure", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (id === null) return;
    send(ws, {
      jsonrpc: "2.0",
      id,
      error: {
        code: AgentJsonRpcCode.InternalError,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}
