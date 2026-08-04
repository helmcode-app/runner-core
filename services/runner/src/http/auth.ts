import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * When expectedToken is undefined, allow all requests (dev).
 * Otherwise require Authorization: Bearer <token> with constant-time compare.
 */
export function authorize(
  req: IncomingMessage,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return true;
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  return tokensEqual(header.slice("Bearer ".length).trim(), expectedToken);
}

/**
 * WebSocket Upgrade auth (unified ingress for /v1/vfs, /v1/agent, /v1/terminal):
 * 1. Authorization: Bearer <token>
 * 2. Optional `?token=` query (browser / xterm convenience)
 * 3. When OPENCORE_API_TOKEN unset → open (dev)
 */
export function authorizeWebSocketUpgrade(
  req: IncomingMessage,
  expectedToken: string | undefined,
  url?: URL,
  opts: { allowQueryToken?: boolean } = {},
): boolean {
  if (authorize(req, expectedToken)) return true;
  if (!expectedToken) return true;
  if (opts.allowQueryToken === false) return false;
  const q = url?.searchParams.get("token")?.trim();
  if (!q) return false;
  return tokensEqual(q, expectedToken);
}

function tokensEqual(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
