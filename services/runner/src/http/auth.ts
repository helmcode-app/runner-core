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
  const got = header.slice("Bearer ".length).trim();
  const a = Buffer.from(got);
  const b = Buffer.from(expectedToken);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
