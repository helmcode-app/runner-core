/**
 * Session gateway error → HTTP JSON responses.
 */

import type { ServerResponse } from "node:http";
import {
  AgentCapabilityError,
  AgentNotFoundError,
  AgentRuntimeError,
} from "../agent/errors.js";
import { sendJson } from "../http/index.js";
import type { Logger } from "../logger.js";

/** Always returns true so route handlers can `return sendSessionError(...)`. */
export function sendSessionError(
  res: ServerResponse,
  err: unknown,
  log: Logger,
): true {
  if (err instanceof AgentNotFoundError) {
    sendJson(res, 404, { error: err.message });
    return true;
  }
  if (err instanceof AgentCapabilityError) {
    sendJson(res, 501, { error: err.message });
    return true;
  }
  if (err instanceof AgentRuntimeError) {
    log.warn("agent runtime error", {
      status: err.status,
      error: err.message,
    });
    sendJson(res, err.status >= 400 ? err.status : 502, {
      error: err.message,
      ...(err.body !== undefined ? { details: err.body } : {}),
    });
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  log.error("session gateway error", { error: message });
  sendJson(res, 500, { error: message });
  return true;
}
