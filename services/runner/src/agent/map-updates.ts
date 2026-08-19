/**
 * Map ACP session/update notifications → Helm timeline entries + SSE events.
 */

import { randomUUID } from "node:crypto";
import type {
  SessionStreamEvent,
  SessionStatus,
  SessionUsage,
  TimelineEntry,
} from "../sessions/types.js";
import { parseConfigOptions, type HelmConfigOption } from "./session-config.js";

export interface AcpSessionNotification {
  sessionId: string;
  update: Record<string, unknown>;
}

export interface MappedAcpUpdate {
  events: SessionStreamEvent[];
  /** Timeline rows to upsert (by id) or append. */
  timelineUpserts: TimelineEntry[];
  /** Optional session status hint. */
  status?: SessionStatus;
  /** ACP `usage_update` snapshot. */
  usage?: SessionUsage;
  /** ACP `config_option_update` / session/new options. */
  configOptions?: HelmConfigOption[];
}

function textFromContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (typeof c.text === "string") return c.text;
  return "";
}

function nowIso(): string {
  return new Date().toISOString();
}

function asTokenCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return undefined;
}

function asAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Parse ACP `usage_update` (`used` / `size` / optional `cost`). */
export function parseSessionUsage(
  update: Record<string, unknown>,
): SessionUsage | undefined {
  const source =
    update.usage && typeof update.usage === "object"
      ? (update.usage as Record<string, unknown>)
      : update;
  const used = asTokenCount(source.used);
  const size = asTokenCount(source.size);
  if (used === undefined || size === undefined || size <= 0) return undefined;
  const costRaw = source.cost;
  let cost: SessionUsage["cost"];
  if (costRaw && typeof costRaw === "object") {
    const c = costRaw as Record<string, unknown>;
    const amount = asAmount(c.amount);
    const currency = typeof c.currency === "string" ? c.currency.trim() : "";
    if (amount !== undefined && currency.length > 0) {
      cost = { amount, currency };
    }
  }
  return { used, size, ...(cost !== undefined ? { cost } : {}) };
}

/** Fallback window when the harness reports tokens but not `size`. */
export const DEFAULT_CONTEXT_SIZE = 200_000;

/**
 * Map ACP experimental `PromptResponse.usage` (inputTokens/…) onto Helm usage.
 * OpenCode 1.18 may skip `usage_update` when it cannot resolve a context limit.
 */
export function usageFromPromptResult(
  result: Record<string, unknown>,
  fallback?: SessionUsage,
): SessionUsage | undefined {
  const nested =
    result.usage && typeof result.usage === "object"
      ? (result.usage as Record<string, unknown>)
      : result;
  const direct = parseSessionUsage(nested);
  if (direct) return direct;

  const input = asTokenCount(nested.inputTokens) ?? 0;
  const cached = asTokenCount(nested.cachedReadTokens) ?? 0;
  const total = asTokenCount(nested.totalTokens);
  const output = asTokenCount(nested.outputTokens);
  const used = input + cached > 0 ? input + cached : (total ?? 0);
  if (used <= 0 && total === undefined && output === undefined) return undefined;
  const size =
    fallback?.size && fallback.size > 0
      ? fallback.size
      : DEFAULT_CONTEXT_SIZE;
  const cost = fallback?.cost;
  return { used, size, ...(cost !== undefined ? { cost } : {}) };
}

/**
 * Normalize one ACP `session/update` notification into Helm events + timeline.
 */
export function mapAcpSessionUpdate(
  params: AcpSessionNotification,
  opts?: { helmSessionId?: string },
): MappedAcpUpdate {
  const at = nowIso();
  const sessionId = opts?.helmSessionId ?? params.sessionId;
  const update = params.update;
  const kind =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : "unknown";

  const baseEvent = (type: string, data: unknown): SessionStreamEvent => ({
    type,
    at,
    sessionId,
    data,
  });

  switch (kind) {
    case "agent_message_chunk":
    case "user_message_chunk": {
      const text = textFromContent(update.content);
      const role = kind === "user_message_chunk" ? "user" : "assistant";
      const id =
        typeof update._meta === "object" &&
        update._meta &&
        typeof (update._meta as Record<string, unknown>).messageId === "string"
          ? String((update._meta as Record<string, unknown>).messageId)
          : `msg_${kind}_${randomUUID()}`;
      // Chunks stream into a synthetic accumulating id per turn is hard without
      // agent message ids — emit event always; timeline uses ephemeral chunk ids.
      return {
        events: [
          baseEvent("session.message.delta", {
            kind,
            role,
            text,
            update,
          }),
        ],
        timelineUpserts: text
          ? [
              {
                id,
                at,
                kind: "message",
                role,
                text,
                done: false,
              },
            ]
          : [],
      };
    }

    case "agent_thought_chunk": {
      const text = textFromContent(update.content);
      return {
        events: [
          baseEvent("session.reasoning.delta", { text, update }),
        ],
        timelineUpserts: text
          ? [
              {
                id: `thought_${randomUUID()}`,
                at,
                kind: "reasoning",
                role: "assistant",
                text,
                done: false,
                meta: { reasoning: text },
              },
            ]
          : [],
      };
    }

    case "tool_call":
    case "tool_call_update": {
      const toolCallId =
        typeof update.toolCallId === "string"
          ? update.toolCallId
          : randomUUID();
      const title =
        typeof update.title === "string" ? update.title : "tool";
      const status =
        typeof update.status === "string" ? update.status : undefined;
      const done =
        status === "completed" ||
        status === "failed" ||
        status === "cancelled";
      return {
        events: [
          baseEvent("session.tool", {
            toolCallId,
            title,
            status,
            update,
          }),
        ],
        timelineUpserts: [
          {
            id: `tool_${toolCallId}`,
            at,
            kind: "tool",
            role: "tool",
            text: title,
            done,
            ...(status !== undefined ? { stage: status } : {}),
            meta: {
              tools: [title],
              toolCallId,
              status,
            },
          },
        ],
        ...(status === "in_progress" || status === "pending"
          ? { status: "running" as const }
          : {}),
      };
    }

    case "current_mode_update": {
      return {
        events: [baseEvent("session.mode", { update })],
        timelineUpserts: [],
      };
    }

    case "usage_update": {
      const usage = parseSessionUsage(update);
      return {
        events: [baseEvent("session.usage", usage ?? { update })],
        timelineUpserts: [],
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    case "config_option_update": {
      const configOptions = parseConfigOptions(update.configOptions);
      return {
        events: [baseEvent("session.config", { update })],
        timelineUpserts: [],
        ...(configOptions.length > 0 ? { configOptions } : {}),
      };
    }

    default:
      return {
        events: [baseEvent("session.event", { kind, update })],
        timelineUpserts: [],
      };
  }
}

/** Map ACP prompt stopReason → Helm session status. */
export function mapStopReason(stopReason: string | undefined): SessionStatus {
  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "failed";
    default:
      return stopReason ? "completed" : "idle";
  }
}
