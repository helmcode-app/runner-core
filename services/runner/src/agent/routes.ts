/**
 * HTTP surface for durable agent / ACP harness configuration.
 *
 *   GET  /v1/agent          current selection + catalog + phase
 *   PUT  /v1/agent          enable / switch harness / update key
 *   DELETE /v1/agent        disable sessions (keeps last harness id)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "../http/index.js";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "./harnesses/catalog.js";
import {
  isAgentProviderId,
  normalizeAgentProviderId,
} from "./harnesses/opencode/auth.js";
import type { AgentConfigUpdate } from "./config-store.js";
import {
  AgentConfigError,
  type AgentRuntimeController,
} from "./runtime-controller.js";

export interface AgentRouteContext {
  agent: AgentRuntimeController;
}

/**
 * Handle `/v1/agent`. Returns true if the path was claimed.
 */
export async function handleAgentHttp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  ctx: AgentRouteContext,
): Promise<boolean> {
  if (pathname !== "/v1/agent") return false;

  if (method === "GET") {
    sendJson(res, 200, ctx.agent.view());
    return true;
  }

  if (method === "DELETE") {
    try {
      const view = await ctx.agent.disable();
      sendJson(res, 200, view);
    } catch (err) {
      sendAgentConfigError(res, err);
    }
    return true;
  }

  if (method === "PUT") {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return true;
    }
    const parsed = parseAgentConfigUpdate(body);
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error });
      return true;
    }
    try {
      const view = await ctx.agent.apply(parsed.value);
      const status =
        view.enabled && view.phase === "error"
          ? 503
          : 200;
      sendJson(res, status, view);
    } catch (err) {
      sendAgentConfigError(res, err);
    }
    return true;
  }

  sendJson(res, 405, { error: "method not allowed" });
  return true;
}

function sendAgentConfigError(res: ServerResponse, err: unknown): void {
  if (err instanceof AgentConfigError) {
    sendJson(res, err.statusCode, { error: err.message });
    return;
  }
  sendJson(res, 500, {
    error: err instanceof Error ? err.message : "agent config error",
  });
}

function parseAgentConfigUpdate(
  body: unknown,
): { ok: true; value: AgentConfigUpdate } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "body must be an object" };
  }
  const row = body as Record<string, unknown>;
  if (typeof row.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  if (
    typeof row.harness !== "string" ||
    !(AGENT_HARNESS_IDS as readonly string[]).includes(row.harness)
  ) {
    return {
      ok: false,
      error: `harness must be one of: ${AGENT_HARNESS_IDS.join(", ")}`,
    };
  }

  const value: AgentConfigUpdate = {
    enabled: row.enabled,
    harness: row.harness as AgentHarnessId,
  };

  if (row.provider !== undefined) {
    if (typeof row.provider !== "string") {
      return {
        ok: false,
        error: "provider must be opencode-go (aliases: opencode, opencode-go-plus)",
      };
    }
    const provider = normalizeAgentProviderId(row.provider);
    if (!provider || !isAgentProviderId(row.provider)) {
      return {
        ok: false,
        error: "provider must be opencode-go (aliases: opencode, opencode-go-plus)",
      };
    }
    value.provider = provider;
  }

  if (row.apiKey !== undefined) {
    if (typeof row.apiKey !== "string") {
      return { ok: false, error: "apiKey must be a string" };
    }
    value.apiKey = row.apiKey;
  }

  if (row.defaultModel !== undefined) {
    if (row.defaultModel === null) {
      value.defaultModel = null;
    } else if (typeof row.defaultModel === "string") {
      value.defaultModel = row.defaultModel;
    } else {
      return { ok: false, error: "defaultModel must be a string or null" };
    }
  }

  return { ok: true, value };
}
