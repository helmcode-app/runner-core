/**
 * Stable HelmCode agent-session DTOs (backend-agnostic).
 * OpenCode (or another harness) maps into these shapes at the gateway boundary.
 */

/** Product execution intent (iPad composer). */
export type SessionMode = "agent" | "plan" | "ask";

/** High-level session lifecycle for UI chips. */
export type SessionStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface AgentSession {
  id: string;
  title?: string;
  status: SessionStatus;
  createdAt?: string;
  updatedAt?: string;
  /** Opaque backend id if different from `id` (usually same). */
  backend?: string;
}

/** One node in the reconnectable timeline. */
export type TimelineRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type TimelineKind =
  | "message"
  | "reasoning"
  | "tool"
  | "status"
  | "error"
  | "diff"
  | "unknown";

export interface TimelineEntry {
  id: string;
  at?: string;
  kind: TimelineKind;
  role: TimelineRole;
  /** Primary display text (aggregated from parts when needed). */
  text: string;
  /** Optional structured stage for badges (maps loosely across backends). */
  stage?: string;
  /**
   * This message finished (OpenCode `time.completed` / `finish`).
   * A full agent *turn* may include several assistant messages (thinking →
   * tools → answer). Clients must wait until every new message after the
   * user prompt is done, and history is stable, before marking success.
   */
  done?: boolean;
  /**
   * Optional structured extras:
   * - `reasoning` (string) chain-of-thought for collapsed UI
   * - `tools` (string[]) compact action labels
   * - `answer` (string) final text excluding reasoning
   */
  meta?: Record<string, unknown>;
}

export interface CreateSessionRequest {
  title?: string;
  parentId?: string;
}

export interface CreateSessionResponse {
  session: AgentSession;
}

export interface ListSessionsResponse {
  sessions: AgentSession[];
}

export interface GetSessionResponse {
  session: AgentSession;
}

export interface PromptRequest {
  prompt: string;
  model?: string;
  mode?: SessionMode;
  contextPaths?: string[];
  system?: string;
  messageId?: string;
}

export interface PromptAccepted {
  sessionId: string;
  status: "accepted";
  mode: SessionMode;
  model?: string;
}

export interface SessionHistoryResponse {
  sessionId: string;
  session?: AgentSession;
  entries: TimelineEntry[];
}

export interface AbortResponse {
  sessionId: string;
  aborted: boolean;
}

/** POST /v1/sessions/:id/revert body (camel or OpenCode casing). */
export interface RevertSessionRequest {
  messageId?: string;
  messageID?: string;
  partId?: string;
  partID?: string;
}

export interface RevertSessionResponse {
  sessionId: string;
  reverted?: boolean;
  unreverted?: boolean;
  session?: AgentSession;
}

export interface SessionDiffResponse {
  sessionId: string;
  diffs: unknown[];
}

export interface RuntimeHealthResponse {
  ok: boolean;
  /** Implementation name for diagnostics only (not for client branching). */
  provider?: string;
  version?: string;
  error?: string;
}

/**
 * SSE event envelope pushed to the iPad.
 * `type` is stable; `data` is normalized when possible.
 */
export interface SessionStreamEvent {
  type: string;
  at: string;
  sessionId?: string;
  data?: unknown;
}
