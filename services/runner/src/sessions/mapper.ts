/**
 * Map OpenCode (or similar) wire payloads → Helm session DTOs.
 *
 * Layout:
 * - `map-util.ts`  — pure field helpers
 * - `map-tools.ts` — tool/patch → ToolAction
 * - this file      — session + history timeline
 */

import type {
  AgentSession,
  SessionStatus,
  TimelineEntry,
  TimelineKind,
  TimelineRole,
} from "./types.js";
import { asRecord, firstString } from "./map-util.js";
import {
  formatPatchParts,
  formatToolPart,
  type ToolAction,
} from "./map-tools.js";

export type { ToolAction } from "./map-tools.js";

// ── Session ──────────────────────────────────────────────────

export function mapSession(raw: unknown): AgentSession {
  const o = asRecord(raw);
  const id = firstString(o, ["id", "sessionID", "sessionId"]) ?? "";
  if (!id) {
    throw new Error("session response missing id");
  }

  const title = firstString(o, ["title", "name"]);
  const createdAt = firstString(o, ["time.created", "createdAt", "created"]);
  const updatedAt = firstString(o, ["time.updated", "updatedAt", "updated"]);
  const status = inferSessionStatus(o);

  return {
    id,
    status,
    backend: "session-runtime",
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

export function mapSessionList(raw: unknown): AgentSession[] {
  const list = Array.isArray(raw)
    ? raw
    : asRecord(raw).sessions ?? asRecord(raw).items;
  if (!Array.isArray(list)) return [];
  return list.map((item) => mapSession(item));
}

// ── History / timeline ───────────────────────────────────────

/**
 * OpenCode: `{ info: Message, parts: Part[] }[]`
 * Also accepts already-flat message arrays.
 */
export function mapHistoryToTimeline(raw: unknown): TimelineEntry[] {
  if (!Array.isArray(raw)) {
    const o = asRecord(raw);
    const messages = o.messages ?? o.items;
    if (Array.isArray(messages)) return mapHistoryToTimeline(messages);
    return [];
  }

  const entries: TimelineEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const mapped = mapMessageItem(raw[i], i);
    if (mapped) entries.push(mapped);
  }
  return entries;
}

function mapMessageItem(item: unknown, index: number): TimelineEntry | null {
  const o = asRecord(item);
  const info = asRecord(o.info ?? o);
  const parts = Array.isArray(o.parts) ? o.parts : [];

  const id =
    firstString(info, ["id", "messageID", "messageId"]) ??
    firstString(o, ["id"]) ??
    `msg-${index}`;

  const role = mapRole(
    firstString(info, ["role", "type"]) ?? firstString(o, ["role"]),
  );
  const at =
    firstString(info, ["time.created", "createdAt", "time"]) ??
    firstString(o, ["createdAt", "at"]);

  const classified = classifyParts(parts, info, o);
  const done = isMessageDone(role, info, parts);
  const kind = mapKind(role, classified);

  let text = classified.displayText;
  // Skip empty step shells; keep in-progress assistant as a placeholder.
  if (!text.trim()) {
    if (role === "assistant" && !done) {
      text = "Working…";
    } else {
      return null;
    }
  }

  return {
    id,
    kind,
    role,
    text,
    done,
    ...(at !== undefined ? { at } : {}),
    meta: {
      partCount: parts.length,
      done,
      ...(classified.reasoning ? { reasoning: classified.reasoning } : {}),
      ...(classified.tools.length ? { tools: classified.tools } : {}),
      ...(classified.toolActions.length
        ? { toolActions: classified.toolActions }
        : {}),
      ...(classified.answer ? { answer: classified.answer } : {}),
      ...(firstString(info, ["agent"])
        ? { agent: firstString(info, ["agent"]) }
        : {}),
      ...(firstString(info, ["finish"])
        ? { finish: firstString(info, ["finish"]) }
        : {}),
    },
  };
}

// ── Parts classification ─────────────────────────────────────

interface ClassifiedParts {
  displayText: string;
  answer: string;
  reasoning: string;
  tools: string[];
  toolActions: ToolAction[];
  hasText: boolean;
  hasReasoning: boolean;
  hasTools: boolean;
}

/**
 * Split OpenCode parts into answer / reasoning / tools for Cursor-style UI.
 */
function classifyParts(
  parts: unknown[],
  info: Record<string, unknown>,
  o: Record<string, unknown>,
): ClassifiedParts {
  const answers: string[] = [];
  const reasoning: string[] = [];
  const toolActions: ToolAction[] = [];

  for (const p of parts) {
    const pr = asRecord(p);
    const type = (firstString(pr, ["type"]) ?? "").toLowerCase();

    if (
      type === "reasoning" ||
      type === "thinking" ||
      type === "reason" ||
      type === "thought"
    ) {
      const t =
        firstString(pr, ["text", "content", "value", "reasoning"]) ?? "";
      if (t.trim()) reasoning.push(t.trim());
      continue;
    }

    if (
      type === "tool" ||
      type === "tool-invocation" ||
      type === "tool_use" ||
      type === "tool-call" ||
      type === "tool-result" ||
      type === "tool_result"
    ) {
      const action = formatToolPart(pr);
      if (action) toolActions.push(action);
      continue;
    }

    if (type === "patch") {
      toolActions.push(...formatPatchParts(pr));
      continue;
    }

    // Internal noise — not user-facing.
    if (
      type === "step-start" ||
      type === "step-finish" ||
      type === "snapshot" ||
      type === "retry" ||
      type === "compaction" ||
      type === "agent" ||
      type === "file"
    ) {
      continue;
    }

    const t =
      firstString(pr, ["text", "content", "value"]) ??
      (typeof pr.text === "string" ? pr.text : undefined);
    if (!t?.trim()) continue;

    if (
      pr.thinking === true ||
      pr.reasoning === true ||
      firstString(pr, ["kind", "channel"]) === "thinking"
    ) {
      reasoning.push(t.trim());
    } else {
      answers.push(t.trim());
    }
  }

  if (
    answers.length === 0 &&
    reasoning.length === 0 &&
    toolActions.length === 0
  ) {
    const fallback =
      firstString(info, ["content", "text", "summary"]) ??
      firstString(o, ["content", "text"]) ??
      "";
    if (fallback.trim()) answers.push(fallback.trim());
  }

  const answer = answers.join("\n\n");
  const reasoningText = reasoning.join("\n\n");
  // OpenCode often emits both a tool (edit/write) and a PatchPart for the same
  // file — keep the richer row (with content) only.
  const dedupedActions = dedupeToolActions(toolActions);
  const tools = dedupedActions.map((a) => a.label);
  const hasText = answer.length > 0;
  const hasReasoning = reasoningText.length > 0;
  const hasTools = dedupedActions.length > 0;

  let displayText = answer;
  if (!displayText && hasTools) displayText = tools.join("\n");
  if (!displayText && hasReasoning) displayText = reasoningText;

  return {
    displayText,
    answer,
    reasoning: reasoningText,
    tools,
    toolActions: dedupedActions,
    hasText,
    hasReasoning,
    hasTools,
  };
}

/** Collapse edit + patch rows that refer to the same path. */
function dedupeToolActions(actions: ToolAction[]): ToolAction[] {
  const best = new Map<string, ToolAction>();
  const order: string[] = [];

  const fileChangeKey = (a: ToolAction): string => {
    const n = a.name.toLowerCase();
    const isFileChange =
      n === "edit" ||
      n === "write" ||
      n === "create" ||
      n === "patch" ||
      n.includes("replace") ||
      n.includes("patch");
    const path = a.path ?? a.label;
    return isFileChange ? `file|${path}` : `${n}|${path}`;
  };

  for (const a of actions) {
    const key = fileChangeKey(a);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, a);
      order.push(key);
      continue;
    }
    const existingLen = existing.content?.length ?? 0;
    const nextLen = a.content?.length ?? 0;
    if (
      nextLen > existingLen ||
      (nextLen === existingLen && a.name !== "patch" && existing.name === "patch")
    ) {
      best.set(key, a);
    }
  }
  return order.map((k) => best.get(k)!).filter(Boolean);
}

// ── Status / kind / role ─────────────────────────────────────

function isMessageDone(
  role: TimelineRole,
  info: Record<string, unknown>,
  parts: unknown[],
): boolean {
  if (role !== "assistant") return true;

  if (firstString(info, ["finish", "error"])) return true;

  const time = asRecord(info.time);
  if (time.completed !== undefined && time.completed !== null) return true;
  if (firstString(info, ["time.completed", "completedAt"])) return true;

  for (const p of parts) {
    const pr = asRecord(p);
    if (firstString(pr, ["type"]) === "step-finish") {
      const reason = firstString(pr, ["reason"])?.toLowerCase() ?? "";
      if (
        reason === "stop" ||
        reason === "end" ||
        reason === "complete" ||
        reason === "length"
      ) {
        return true;
      }
    }
  }
  return false;
}

function mapKind(
  role: TimelineRole,
  classified: ClassifiedParts,
): TimelineKind {
  if (role === "tool") return "tool";
  if (role === "system") return "status";
  if (classified.hasReasoning && !classified.hasText && !classified.hasTools) {
    return "reasoning";
  }
  if (classified.hasTools && !classified.hasText) return "tool";
  if (classified.hasText) return "message";
  if (classified.hasReasoning) return "reasoning";
  return "message";
}

function mapRole(raw: string | undefined): TimelineRole {
  if (!raw) return "unknown";
  const r = raw.toLowerCase();
  if (r === "user" || r === "human") return "user";
  if (r === "assistant" || r === "agent" || r === "model") return "assistant";
  if (r === "system") return "system";
  if (r === "tool" || r === "function") return "tool";
  return "unknown";
}

function inferSessionStatus(o: Record<string, unknown>): SessionStatus {
  const s =
    firstString(o, ["status", "state", "phase"])?.toLowerCase() ?? "";
  // OpenCode session objects often have no status — do not invent "running".
  if (!s) return "idle";
  if (/(run|busy|active|progress|stream|pending)/.test(s)) return "running";
  if (/(complete|done|success|idle|ready)/.test(s)) return "completed";
  if (/(fail|error)/.test(s)) return "failed";
  if (/(cancel|abort)/.test(s)) return "cancelled";
  return "unknown";
}
