import { accessSync, constants as fsConstants } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "../config.js";
import {
  attachAuthenticatedUpgrade,
  authorizeWebSocketUpgrade,
} from "../http/index.js";
import type { Logger } from "../logger.js";
import { clampInt } from "../util/env.js";
import {
  parseWorkspaceId,
  WorkspaceNotFoundError,
  type WorkspaceRegistry,
} from "../workspaces/index.js";
import { spawnLocalPty } from "./local-pty.js";
import { encodeServerMessage } from "./protocol.js";
import { TerminalSession } from "./session.js";

/** Unified-ingress WebSSH path (shares open-core host/port with /v1/vfs). */
export const TERMINAL_WS_PATH = "/v1/terminal";
/** Alias matching common reverse-proxy layouts. */
export const TERMINAL_WS_PATH_ALIAS = "/api/v1/terminal/ws";

const TERMINAL_PATHS = [TERMINAL_WS_PATH, TERMINAL_WS_PATH_ALIAS] as const;

export interface TerminalGateway {
  close(): Promise<void>;
  readonly enabled: boolean;
  readonly activeSessions: number;
}

/**
 * WebSSH gateway: WebSocket ↔ in-process PTY (node-pty).
 *
 * No Docker socket. Shell runs in the runner process namespace with
 * cwd from `?workspaceId=` (default workspace) or TERMINAL_WORKDIR overlay.
 *
 * Upgrade auth: Bearer + optional `?token=` (same OPENCORE_API_TOKEN).
 */
export function createTerminalGateway(
  server: Server,
  config: AppConfig,
  logger: Logger,
  workspaces: WorkspaceRegistry,
): TerminalGateway {
  const log = logger.child({ component: "terminal-ws" });
  const enabled = config.TERMINAL_ENABLED;

  if (!enabled) {
    log.info("terminal gateway disabled (TERMINAL_ENABLED=false)");
    return {
      enabled: false,
      activeSessions: 0,
      close: async () => undefined,
    };
  }

  const apiToken = config.OPENCORE_API_TOKEN?.trim() || undefined;
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set<TerminalSession>();
  const maxSessions = config.TERMINAL_MAX_SESSIONS;
  const defaultWorkdir = resolveWorkdir(
    config.TERMINAL_WORKDIR || workspaces.get().path,
  );

  const onUpgrade = attachAuthenticatedUpgrade(server, {
    path: TERMINAL_PATHS,
    wss,
    apiToken,
    allowQueryToken: true,
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, url: URL) => {
      openSession(ws, url);
    },
  );

  function openSession(ws: WebSocket, url: URL): void {
    const cols = clampInt(url.searchParams.get("cols"), 80, 1, 500);
    const rows = clampInt(url.searchParams.get("rows"), 24, 1, 200);
    const workspaceId = parseWorkspaceId(url.searchParams.get("workspaceId"));
    let workdir = defaultWorkdir;
    try {
      const workspace = workspaces.get(workspaceId);
      workdir = resolveWorkdir(
        workspace.id === "default" && config.TERMINAL_WORKDIR
          ? config.TERMINAL_WORKDIR
          : workspace.path,
      );
    } catch (err) {
      const message =
        err instanceof WorkspaceNotFoundError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      log.warn("terminal session rejected", { reason: "workspace", workspaceId });
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(encodeServerMessage({ type: "error", message }));
          ws.close(1008, "unknown workspace");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (sessions.size >= maxSessions) {
      const message = `Terminal session limit reached (${maxSessions}). Close another session and retry.`;
      log.warn("terminal session rejected", { reason: "max_sessions", maxSessions });
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(encodeServerMessage({ type: "error", message }));
          ws.close(1013, "session limit");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    let session: TerminalSession | undefined;
    try {
      const pty = spawnLocalPty({
        shell: config.TERMINAL_SHELL,
        cwd: workdir,
        cols,
        rows,
      });

      session = new TerminalSession({
        ws,
        pty,
        log,
        heartbeatMs: config.TERMINAL_HEARTBEAT_MS,
        onClose: () => {
          if (session) sessions.delete(session);
        },
      });
      sessions.add(session);

      log.info("terminal session started", {
        sessionId: pty.sessionId,
        shell: pty.shell,
        cwd: pty.cwd,
        workspaceId,
        cols,
        rows,
        active: sessions.size,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("terminal session failed to start", { error: message });
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(encodeServerMessage({ type: "error", message }));
          ws.close(1011, "pty failed");
        } catch {
          /* ignore */
        }
      } else {
        try {
          ws.close(1011, "pty failed");
        } catch {
          /* ignore */
        }
      }
    }
  }

  log.info("terminal gateway ready", {
    path: TERMINAL_WS_PATH,
    alias: TERMINAL_WS_PATH_ALIAS,
    backend: "local-pty",
    shell: config.TERMINAL_SHELL,
    workdir: defaultWorkdir,
    maxSessions,
  });

  return {
    enabled: true,
    get activeSessions() {
      return sessions.size;
    },
    close: async () => {
      server.off("upgrade", onUpgrade);
      for (const s of sessions) s.close("gateway shutdown");
      sessions.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Auth for HTTP Upgrade (exported for unit tests).
 * Prefer {@link authorizeWebSocketUpgrade} for new code.
 */
export function authorizeTerminalUpgrade(
  req: IncomingMessage,
  url: URL,
  expectedToken: string | undefined,
): boolean {
  return authorizeWebSocketUpgrade(req, expectedToken, url, {
    allowQueryToken: true,
  });
}

function resolveWorkdir(preferred: string): string {
  const candidates = [preferred, process.cwd(), "/tmp"];
  for (const c of candidates) {
    if (!c) continue;
    try {
      accessSync(c, fsConstants.R_OK | fsConstants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return process.cwd();
}
