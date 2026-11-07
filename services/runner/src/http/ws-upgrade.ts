import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";


/** Parse request URL for HTTP Upgrade handlers. */
export function parseUpgradeUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? "localhost";
  return new URL(req.url ?? "/", `http://${host}`);
}

/** Write 401 and destroy the raw upgrade socket. */
export function rejectUpgradeUnauthorized(socket: Duplex): void {
  try {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  } catch {
    /* ignore */
  }
  socket.destroy();
}

export type PathMatcher =
  | string
  | readonly string[]
  | ((pathname: string) => boolean);

function pathMatches(pathname: string, matcher: PathMatcher): boolean {
  if (typeof matcher === "function") return matcher(pathname);
  if (typeof matcher === "string") return pathname === matcher;
  return matcher.includes(pathname);
}

export interface AttachUpgradeOptions {
  /** Path(s) or predicate; non-matching upgrades are ignored (other handlers may claim them). */
  path: PathMatcher;
  wss: WebSocketServer;
  /** Device Bearer or a single-use `?ticket=`. Long-lived `?token=` is not accepted. */
  authorize: (req: IncomingMessage, url: URL) => boolean;
  /**
   * After successful upgrade, emitted as `wss.emit("connection", ws, req, url)`.
   * Handlers may ignore the third argument.
   */
}

/**
 * Register a single `upgrade` listener that authenticates and hands off to `wss`.
 * Returns the bound listener so callers can `server.off("upgrade", listener)` on close.
 */
export function attachAuthenticatedUpgrade(
  server: Server,
  opts: AttachUpgradeOptions,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const url = parseUpgradeUrl(req);
    if (!pathMatches(url.pathname, opts.path)) return;

    if (!opts.authorize(req, url)) {
      rejectUpgradeUnauthorized(socket);
      return;
    }

    opts.wss.handleUpgrade(req, socket, head, (ws) => {
      opts.wss.emit("connection", ws, req, url);
    });
  };

  server.on("upgrade", onUpgrade);
  return onUpgrade;
}

/** Close every socket in a set and clear it. */
export function closeWebSockets(sockets: Iterable<{ close(): void }>): void {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}
