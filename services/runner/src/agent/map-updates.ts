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

/** Fallback window when the harness reports tokens but not `size`. */
export const DEFAULT_CONTEXT_SIZE = 200_000;

function extractCost(
  source: Record<string, unknown>,
): SessionUsage["cost"] | undefined {
  const costRaw = source.cost;
  if (!costRaw || typeof costRaw !== "object") return undefined;
  const c = costRaw as Record<string, unknown>;
  const amount = asAmount(c.amount);
  const currency = typeof c.currency === "string" ? c.currency.trim() : "";
  if (amount === undefined || currency.length === 0) return undefined;
  return { amount, currency };
}

function resolveSize(
  source: Record<string, unknown>,
  fallback?: SessionUsage,
): number {
  const size =
    asTokenCount(source.size) ??
    asTokenCount(source.context_size) ??
    asTokenCount(source.contextSize) ??
    asTokenCount(source.context_window) ??
    asTokenCount(source.max_tokens);
  if (size !== undefined && size > 0) return size;
  if (fallback?.size && fallback.size > 0) return fallback.size;
  return DEFAULT_CONTEXT_SIZE;
}

/**
 * Parse ACP `usage_update` (`used` / `size` / optional `cost`).
 * OpenCode may omit `size` when it cannot resolve a context limit — keep `used`.
 */
export function parseSessionUsage(
  update: Record<string, unknown>,
  fallback?: SessionUsage,
): SessionUsage | undefined {
  const source =
    update.usage && typeof update.usage === "object"
      ? (update.usage as Record<string, unknown>)
      : update;
  const used = asTokenCount(source.used);
  if (used === undefined) return undefined;
  const size = resolveSize(source, fallback);
  const cost = extractCost(source) ?? fallback?.cost;
  return { used, size, ...(cost !== undefined ? { cost } : {}) };
}

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
  const direct = parseSessionUsage(nested, fallback);
  if (direct) return direct;

  const input =
    asTokenCount(nested.inputTokens) ??
    asTokenCount(nested.input_tokens) ??
    asTokenCount(nested.prompt_tokens) ??
    0;
  const cached =
    asTokenCount(nested.cachedReadTokens) ??
    asTokenCount(nested.cache_read_input_tokens) ??
    0;
  const total =
    asTokenCount(nested.totalTokens) ??
    asTokenCount(nested.total_tokens) ??
    asTokenCount(nested.tokens);
  const output =
    asTokenCount(nested.outputTokens) ??
    asTokenCount(nested.output_tokens) ??
    asTokenCount(nested.completion_tokens);
  // Prefer live context occupancy (input + cache). Fall back to totals.
  const used =
    input + cached > 0
      ? input + cached
      : (total ?? (output !== undefined ? output : 0));
  if (used <= 0 && total === undefined && output === undefined) return undefined;
  const size = resolveSize(nested, fallback);
  const cost = extractCost(nested) ?? fallback?.cost;
  return { used, size, ...(cost !== undefined ? { cost } : {}) };
}

/** Merge two usage snapshots — never let a zero placeholder wipe a live used count. */
export function mergeSessionUsage(
  current: SessionUsage | undefined,
  incoming: SessionUsage,
): SessionUsage {
  const used = Math.max(incoming.used, current?.used ?? 0);
  const size =
    incoming.size > 0
      ? incoming.size
      : current?.size && current.size > 0
        ? current.size
        : DEFAULT_CONTEXT_SIZE;
  const cost = incoming.cost ?? current?.cost;
  return {
    used: Math.min(used, size),
    size,
    ...(cost !== undefined ? { cost } : {}),
  };
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
      // Prefer strict used/size; fall back to experimental PromptResponse.usage shape
      // when OpenCode omits size or only reports inputTokens/totalTokens.
      const usage =
        parseSessionUsage(update) ?? usageFromPromptResult(update);
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
