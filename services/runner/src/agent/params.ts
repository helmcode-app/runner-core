import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { AgentRunParams, AgentTask } from "../types.js";
import { DEFAULT_MAX_CYCLES } from "./prompts.js";

/**
 * Map JSON-RPC `agent/run` params → internal {@link AgentTask}.
 */
export function agentRunParamsToTask(params: AgentRunParams): AgentTask {
  if (!params || typeof params.prompt !== "string" || !params.prompt.trim()) {
    throw new Error("prompt is required");
  }
  const taskId =
    typeof params.taskId === "string" && params.taskId.trim()
      ? params.taskId.trim()
      : randomUUID();

  const task: AgentTask = {
    id: taskId,
    prompt: params.prompt,
  };

  if (params.baseBranch !== undefined) task.baseBranch = params.baseBranch;
  if (params.testCommand !== undefined) task.testCommand = params.testCommand;
  if (params.contextPaths !== undefined) task.contextPaths = params.contextPaths;
  if (params.githubToken !== undefined) task.githubToken = params.githubToken;
  if (params.repoPath !== undefined) task.repoPath = params.repoPath;
  if (params.remote !== undefined) task.remote = params.remote;
  if (params.timeoutMs !== undefined) task.timeoutMs = params.timeoutMs;
  if (params.metadata !== undefined) task.metadata = params.metadata;
  if (params.maxCycles !== undefined) task.maxCycles = params.maxCycles;

  return task;
}

/** Resolve self-heal cycle budget: task.maxCycles → metadata → config → default. */
export function resolveMaxCycles(task: AgentTask, config: AppConfig): number {
  if (
    typeof task.maxCycles === "number" &&
    task.maxCycles >= 1 &&
    task.maxCycles <= 10
  ) {
    return Math.floor(task.maxCycles);
  }
  const fromMeta = task.metadata?.["maxCycles"];
  if (typeof fromMeta === "number" && fromMeta >= 1 && fromMeta <= 10) {
    return Math.floor(fromMeta);
  }
  return config.MAX_TEST_RETRIES > 0
    ? config.MAX_TEST_RETRIES
    : DEFAULT_MAX_CYCLES;
}

/** One-line commit-message-safe prompt summary. */
export function summarizePrompt(prompt: string, max = 72): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/** Truncate long logs for timeline / error payloads. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}
