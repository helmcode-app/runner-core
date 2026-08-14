import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentGateway } from "../agent/gateway.js";
import type { Logger } from "../logger.js";
import type { SessionStreamEvent } from "./types.js";

/**
 * Subscribe to Agent Gateway events and stream as Helm SSE.
 */
export async function proxySessionEvents(
  gateway: AgentGateway,
  req: IncomingMessage,
  res: ServerResponse,
  log: Logger,
): Promise<void> {
  const ac = new AbortController();
  const onClose = (): void => ac.abort();
  req.on("close", onClose);
  res.on("close", onClose);

  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    writeSse(res, {
      type: "session.connected",
      at: new Date().toISOString(),
      data: { provider: "acp" },
    });

    const unsubscribe = gateway.subscribe((event) => {
      if (ac.signal.aborted || res.writableEnded) return;
      writeSse(res, event);
    });

    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      ac.signal.addEventListener("abort", done, { once: true });
      req.on("close", done);
      res.on("close", done);
    });

    unsubscribe();
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
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
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
