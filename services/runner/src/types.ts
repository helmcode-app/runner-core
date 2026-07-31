/** Shared domain types for the HelmCode runner-core engine. */

export type HelmMode = "open-core" | "commercial-saas";

export type TaskStatus =
  | "queued"
  | "running"
  | "testing"
  | "healing"
  | "committing"
  | "pushing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AgentTask {
  /** Stable unique id for the task (used in branch + worktree names). */
  id: string;
  /** Natural-language or structured instruction for the agent. */
  prompt: string;
  /** Base branch to branch from (defaults to env DEFAULT_BASE_BRANCH). */
  baseBranch?: string;
  /** Override test command; auto-detected when omitted. */
  testCommand?: string;
  /** Optional absolute path override for the shared main repo. */
  repoPath?: string;
  /** Optional GitHub token override for push auth. */
  githubToken?: string;
  /** Remote name to push to (default: origin). */
  remote?: string;
  /** Extra context files the LLM may inspect (relative to worktree). */
  contextPaths?: string[];
  /**
   * Hard wall-clock budget for the entire agent run (ms).
   * When exceeded the pipeline aborts (kills in-flight subprocesses) with status `cancelled`.
   */
  timeoutMs?: number;
  /** Opaque metadata echoed in status events. */
  metadata?: Record<string, unknown>;
}

export interface FilePatch {
  /** Path relative to worktree root. */
  path: string;
  /** Full file contents after the patch (write/replace semantics). */
  content: string;
  /** Optional: create intermediate directories (default true). */
  ensureDir?: boolean;
}

export interface LlmPatchResponse {
  summary: string;
  patches: FilePatch[];
  /** When true, agent should stop iterating and surface failure. */
  giveUp?: boolean;
  reason?: string;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface TestAttempt {
  attempt: number;
  result: CommandResult;
  healed: boolean;
}

export interface AgentResult {
  taskId: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled">;
  branch: string;
  worktreePath: string;
  commitSha?: string;
  pushRemote?: string;
  testAttempts: TestAttempt[];
  summary: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface TaskProgressEvent {
  taskId: string;
  status: TaskStatus;
  message: string;
  at: string;
  detail?: Record<string, unknown>;
}

export type ProgressCallback = (event: TaskProgressEvent) => void;

/** JSON-RPC 2.0 primitives for commercial-saas gateway control. */
export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcError;

export interface OpenCoreSubmitBody {
  prompt: string;
  id?: string;
  baseBranch?: string;
  testCommand?: string;
  contextPaths?: string[];
  /** Hard overall timeout in ms (falls back to env TASK_TIMEOUT_MS). */
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface HealthStatus {
  ok: true;
  mode: HelmMode;
  version: string;
  uptimeMs: number;
  activeTasks: number;
}
