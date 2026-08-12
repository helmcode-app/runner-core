/**
 * OpenCode Server adapter (private implementation detail).
 * Public HTTP surface lives under `sessions/` → `/v1/sessions/*`.
 *
 * Layout:
 *   client.ts     Session/message API surface
 *   transport.ts  HTTP transport + errors
 *   runtime.ts    Managed install / serve lifecycle
 *   binary.ts     Binary path / package helpers
 *   auth.ts       Auth file materialization
 *   prompt.ts     Async prompt mapping
 *   mode.ts / model.ts  Composer → OpenCode fields
 */
export { OpenCodeClient, type OpenCodeClientOptions } from "./client.js";
export { submitPromptAsync } from "./prompt.js";
export { parseModelRef, toOpenCodeModelField } from "./model.js";
export {
  normalizeMode,
  resolveModeMapping,
  type ModeMapping,
} from "./mode.js";
export {
  OpenCodeUpstreamError,
  type OpenCodeMode,
  type OpenCodeModelRef,
  type PromptBody,
  type PromptAccepted,
  type CreateSessionBody,
} from "./types.js";
export {
  ManagedOpenCodeRuntime,
  createManagedOpenCodeRuntime,
  resolveOpenCodeBinaryPath,
  openCodePackageSpec,
  type ManagedOpenCodeStatus,
  type ManagedRuntimeState,
} from "./runtime.js";
export {
  buildOpenCodeAuthFile,
  materializeOpenCodeAuth,
  resolveOpenCodeAuthPath,
  resolveOpenCodeHome,
  serializeOpenCodeAuthFile,
} from "./auth.js";

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { OpenCodeClient } from "./client.js";

/** Build runtime client when agent sessions are enabled. */
export function createOpenCodeClient(
  config: AppConfig,
  logger: Logger,
): OpenCodeClient | null {
  if (!config.OPENCODE_ENABLED) return null;
  const baseUrl = config.OPENCODE_BASE_URL.replace(/\/+$/, "");
  const basicAuth = config.OPENCODE_SERVER_PASSWORD
    ? {
        username: config.OPENCODE_SERVER_USERNAME || "opencode",
        password: config.OPENCODE_SERVER_PASSWORD,
      }
    : undefined;

  return new OpenCodeClient({
    baseUrl,
    timeoutMs: config.OPENCODE_TIMEOUT_MS,
    ...(basicAuth !== undefined ? { basicAuth } : {}),
    logger: logger.child({ component: "session-runtime-client" }),
  });
}
