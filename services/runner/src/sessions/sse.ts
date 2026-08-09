import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../logger.js";
import type { OpenCodeClient } from "../opencode/client.js";
import { OpenCodeUpstreamError } from "../opencode/types.js";
import type { SessionStreamEvent } from "./types.js";

/**
 * Proxy upstream SSE and re-emit as Helm {@link SessionStreamEvent} lines.
 * Unknown frames are wrapped; parse failures pass through as `raw` type.
 */
export async function proxySessionEvents(
  client: OpenCodeClient,
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
): Promise<void> {
  const ac = new AbortController();
  const onClose = (): void => ac.abort();
  req.on("close", onClose);
  res.on("close", onClose);

  try {
    const upstream = await client.openEventStream(ac.signal);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Hello so clients know the Helm envelope is active.
    writeSse(res, {
      type: "session.connected",
      at: new Date().toISOString(),
      data: { provider: "session-runtime" },
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (ac.signal.aborted || res.writableEnded) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\n\n/);
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const event = normalizeSseChunk(chunk);
          if (event) writeSse(res, event);
        }
      }
      if (buffer.trim()) {
        const event = normalizeSseChunk(buffer);
        if (event) writeSse(res, event);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (ac.signal.aborted) return;
    log.warn("session event stream failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status =
      err instanceof OpenCodeUpstreamError ? mapStatus(err.status) : 502;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    req.off("close", onClose);
    res.off("close", onClose);
  }
}

function writeSse(res: ServerResponse, event: SessionStreamEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function normalizeSseChunk(chunk: string): SessionStreamEvent | null {
  const lines = chunk.split(/\r?\n/);
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim() || eventType;
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0 && !chunk.trim()) return null;

  const rawData = dataLines.join("\n");
  let data: unknown = rawData;
  if (rawData) {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = { raw: rawData };
    }
  }

  const rec = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const sessionId =
    typeof rec.sessionID === "string"
      ? rec.sessionID
      : typeof rec.sessionId === "string"
        ? rec.sessionId
        : typeof rec.session_id === "string"
          ? rec.session_id
          : undefined;

  const type =
    typeof rec.type === "string" && rec.type
      ? rec.type
      : eventType === "message"
        ? "session.event"
        : eventType;

  return {
    type,
    at: new Date().toISOString(),
    ...(sessionId !== undefined ? { sessionId } : {}),
    data,
  };
}

function mapStatus(status: number): number {
  if (status === 401 || status === 403) return status;
  if (status >= 400 && status < 500) return status;
  return 502;
}
