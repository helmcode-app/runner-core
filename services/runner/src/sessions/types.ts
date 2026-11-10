/**
 * Product session DTOs over ACP (REST + SSE for iPad).
 * Paths follow ACP session methods; JSON is Helm, not JSON-RPC.
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

/** Cumulative session cost from ACP `usage_update`. */
export interface SessionUsageCost {
  amount: number;
  currency: string;
}

/** Context window + optional cost (ACP `usage_update`). */
export interface SessionUsage {
  used: number;
  size: number;
  cost?: SessionUsageCost;
}

/** Reasoning effort on `POST /v1/sessions/:id/prompt`. */
export type ThinkLevel = "low" | "medium" | "high" | "xhigh";

export interface AgentSession {
  id: string;
  title?: string;
  status: SessionStatus;
  createdAt?: string;
  updatedAt?: string;
  /** ACP session id when it differs from the Helm id. */
  backend?: string;
  /** ACP `session/new` advertised mode ids (`build`, `plan`, …). */
  modes?: string[];
  /** Workspace this session edits (default `default` = MAIN_REPO_PATH). */
  workspaceId?: string;
  /** Latest ACP `usage_update` snapshot. */
  usage?: SessionUsage;
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
  /** Bind to a workspace from GET /v1/workspaces. Omitted → `default`. */
  workspaceId?: string;
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
  /** ACP thought/reasoning level (`session/set_config_option` + `_meta.helm`). */
  thinkLevel?: ThinkLevel | string;
  /** Thinking on/off when the harness advertises a toggle (`true`/`false`). */
  thinking?: string | boolean;
  /** Context window size (`200k` / `1m` / …) when advertised. */
  context?: string;
  /** Faster inference when true (`session/set_config_option` + `_meta.helm`). */
  fast?: boolean;
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
  /** Session-level context window + cost (ACP `usage_update`). */
  usage?: SessionUsage;
}

/** POST /v1/sessions/:id/cancel → ACP `session/cancel`. */
export interface CancelResponse {
  sessionId: string;
  cancelled: boolean;
}

/**
 * POST /v1/sessions/:id/rewind — product checkpoint rewind (not ACP).
 * Default `restore` is `both` (conversation + workspace files).
 */
export type RewindRestore = "both" | "conversation" | "code";

export interface RewindRequest {
  /** User timeline id (`user_<uuid>`). That message and everything after are dropped. */
  messageId: string;
  restore?: RewindRestore;
}

export interface RewindResponse {
  sessionId: string;
  messageId: string;
  restore: RewindRestore;
  /** Original user prompt, for the composer. */
  prompt: string;
  session: AgentSession;
  /** Timeline rows removed (the target message and after). */
  truncated: number;
  filesRestored: boolean;
  entries: TimelineEntry[];
}

export interface SessionModel {
  id: string;
  name: string;
  provider: string;
  connected: boolean;
}

export interface SessionModelsResponse {
  models: SessionModel[];
  connected: string[];
  defaultModel?: string;
  /**
   * Effort / reasoning levels the current harness accepts (product ids like
   * `low`/`medium`/`high`/`xhigh`, or harness-native labels). Empty/omit =
   * hide the Think control.
   */
  thinkLevels?: string[];
  /** Thinking on/off values when advertised (`false`/`true`). */
  thinkingLevels?: string[];
  /** Context window sizes when advertised (`200k`/`1m`/…). */
  contextLevels?: string[];
  /** Current context window selection when known. */
  context?: string;
  /** Whether the harness advertises a fast / turbo option. */
  supportsFast?: boolean;
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
