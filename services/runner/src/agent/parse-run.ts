import { randomUUID } from "node:crypto";
import type { AgentRunParams } from "../types.js";

/** Parse and validate JSON-RPC `agent/run` params. */
export function parseAgentRunParams(raw: unknown): AgentRunParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object");
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.prompt !== "string" || !p.prompt.trim()) {
    throw new Error("prompt is required");
  }

  const taskIdRaw = p.taskId ?? p.id;
  if (taskIdRaw !== undefined && typeof taskIdRaw !== "string") {
    throw new Error("taskId must be a string");
  }
  const taskId =
    typeof taskIdRaw === "string" && taskIdRaw.trim()
      ? taskIdRaw.trim()
      : randomUUID();

  const out: AgentRunParams = {
    taskId,
    prompt: p.prompt,
  };

  assignOptionalString(out, p, "baseBranch");
  assignOptionalString(out, p, "testCommand");
  assignOptionalString(out, p, "githubToken");
  assignOptionalString(out, p, "repoPath");
  assignOptionalString(out, p, "remote");

  if (p.contextPaths !== undefined) {
    if (
      !Array.isArray(p.contextPaths) ||
      !p.contextPaths.every((x) => typeof x === "string")
    ) {
      throw new Error("contextPaths must be an array of strings");
    }
    out.contextPaths = p.contextPaths as string[];
  }
  if (p.maxCycles !== undefined) {
    if (
      typeof p.maxCycles !== "number" ||
      !Number.isInteger(p.maxCycles) ||
      p.maxCycles < 1
    ) {
      throw new Error("maxCycles must be a positive integer");
    }
    out.maxCycles = p.maxCycles;
  }
  if (p.timeoutMs !== undefined) {
    if (typeof p.timeoutMs !== "number" || p.timeoutMs < 0) {
      throw new Error("timeoutMs must be a non-negative number");
    }
    out.timeoutMs = p.timeoutMs;
  }
  if (p.metadata !== undefined) {
    if (!p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata)) {
      throw new Error("metadata must be an object");
    }
    out.metadata = p.metadata as Record<string, unknown>;
  }

  return out;
}

/** Require `taskId` (or legacy `id`) from cancel/status params. */
export function extractTaskId(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with taskId");
  }
  const p = raw as Record<string, unknown>;
  const taskId = p.taskId ?? p.id;
  if (typeof taskId !== "string" || !taskId.trim()) {
    throw new Error("taskId is required");
  }
  return taskId.trim();
}

function assignOptionalString(
  out: AgentRunParams,
  p: Record<string, unknown>,
  key: "baseBranch" | "testCommand" | "githubToken" | "repoPath" | "remote",
): void {
  if (p[key] === undefined) return;
  if (typeof p[key] !== "string") {
    throw new Error(`${key} must be a string`);
  }
  out[key] = p[key] as string;
}
