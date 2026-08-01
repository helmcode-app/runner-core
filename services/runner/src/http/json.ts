import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export async function readJson(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total > maxBytes) {
      throw new Error("request body too large");
    }
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}
