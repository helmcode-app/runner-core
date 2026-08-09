/**
 * Session gateway error → HTTP JSON responses.
 */

import type { ServerResponse } from "node:http";
import { sendJson } from "../http/index.js";
import type { Logger } from "../logger.js";
import { OpenCodeUpstreamError } from "../opencode/types.js";

/** Always returns true so route handlers can `return sendSessionError(...)`. */
export function sendSessionError(
  res: ServerResponse,
  err: unknown,
  log: Logger,
): true {
  if (err instanceof OpenCodeUpstreamError) {
    log.warn("session runtime upstream error", {
      status: err.status,
      error: err.message,
    });
    const httpStatus =
      err.status >= 400 && err.status < 600 && err.status !== 502
        ? err.status
        : 502;
    sendJson(res, httpStatus >= 400 ? httpStatus : 502, {
      error: err.message,
      details: err.body,
    });
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error("session gateway error", { error: message });
  sendJson(res, 500, { error: message });
  return true;
}
