/**
 * Pure rewind planning: truncate timeline + keep earlier checkpoints.
 * File restore and ACP session reset happen in the gateway.
 */

import { AgentRuntimeError } from "./errors.js";
import type { TimelineEntry } from "../sessions/types.js";

export type RewindRestore = "both" | "conversation" | "code";

export const REWIND_RESTORE_VALUES = ["both", "conversation", "code"] as const;

export interface SessionCheckpoint {
  messageId: string;
  capturedAt: string;
  prompt: string;
  /** git write-tree SHA when the workspace was a repo. */
  tree?: string;
}

export interface RewindPlan {
  index: number;
  kept: TimelineEntry[];
  removed: TimelineEntry[];
  checkpoint: SessionCheckpoint;
  keptCheckpoints: SessionCheckpoint[];
}

export function parseRewindRestore(value: unknown): RewindRestore {
  if (value == null || value === "") return "both";
  if (
    typeof value === "string" &&
    (REWIND_RESTORE_VALUES as readonly string[]).includes(value)
  ) {
    return value as RewindRestore;
  }
  throw new AgentRuntimeError(
    `restore must be one of ${REWIND_RESTORE_VALUES.join(", ")}`,
    400,
  );
}

export function planRewind(
  timeline: TimelineEntry[],
  checkpoints: SessionCheckpoint[],
  messageId: string,
): RewindPlan {
  const id = messageId.trim();
  if (!id) {
    throw new AgentRuntimeError("messageId is required", 400);
  }

  const index = timeline.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new AgentRuntimeError(`timeline message not found: ${id}`, 404);
  }

  const target = timeline[index];
  if (target?.role !== "user") {
    throw new AgentRuntimeError("rewind target must be a user message", 400);
  }

  const checkpoint = checkpoints.find((item) => item.messageId === id);
  if (!checkpoint) {
    throw new AgentRuntimeError(`no checkpoint for message ${id}`, 400);
  }

  const kept = timeline.slice(0, index);
  const keptIds = new Set(kept.map((entry) => entry.id));
  return {
    index,
    kept,
    removed: timeline.slice(index),
    checkpoint,
    keptCheckpoints: checkpoints.filter((item) => keptIds.has(item.messageId)),
  };
}

/** Compact transcript so a replacement ACP session can continue prior turns. */
export function formatSeedContext(entries: TimelineEntry[]): string | undefined {
  const blocks: string[] = [];
  for (const entry of entries) {
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    if (entry.kind !== "message" && entry.kind !== "reasoning") continue;
    const text = entry.text.trim();
    if (!text) continue;
    const who = entry.role === "user" ? "User" : "Assistant";
    blocks.push(`${who}:\n${text}`);
  }
  if (blocks.length === 0) return undefined;
  return [
    "The following is the conversation so far in this session. Continue from here; do not repeat it.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
