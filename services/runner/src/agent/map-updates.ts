/**
 * Map ACP session/update notifications → Helm timeline entries + SSE events.
 */

import { randomUUID } from "node:crypto";
import type {
  SessionStreamEvent,
  SessionStatus,
  TimelineEntry,
} from "../sessions/types.js";

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
