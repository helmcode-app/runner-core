/**
 * Gateway-facing types for the OpenCode Server bridge.
 * Upstream wire shapes mirror opencode serve OpenAPI (see https://opencode.ai/docs/server/).
 */

/** HelmCode composer modes (iPad) → OpenCode agent intent. */
export type OpenCodeMode = "agent" | "plan" | "ask";

/** Parsed model reference: `provider/model` or bare model id. */
export interface OpenCodeModelRef {
  /** Raw string from the client (e.g. `anthropic/claude-sonnet-4-20250514`). */
  raw: string;
  /** OpenCode `providerID` when parseable. */
  providerID?: string;
  /** OpenCode `modelID` when parseable. */
  modelID?: string;
}

export interface CreateSessionBody {
  title?: string;
  parentID?: string;
}

export interface PromptBody {
  /** User prompt text. */
  prompt: string;
  /**
   * Model id, preferably `provider/model`
   * (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4-20250514`).
   */
  model?: string;
  /**
   * Execution intent:
   * - `agent` — full autonomous / file-mutation pipeline (OpenCode default build agent)
   * - `plan`  — read-only architectural analysis (OpenCode `plan` agent)
   * - `ask`   — Q&A without writes when supported
   */
  mode?: OpenCodeMode;
  /** Optional system override prepended for plan/ask hardening. */
  system?: string;
  /** Extra context file paths (informational; OpenCode resolves workspace itself). */
  contextPaths?: string[];
  /** Optional client message id. */
  messageID?: string;
}

export interface PromptAccepted {
  sessionId: string;
  status: "accepted";
  mode: OpenCodeMode;
  /** OpenCode agent name used for this turn (debug). */
  agent?: string;
  model?: string;
}

/** Error thrown when the local `opencode serve` process is down or returns non-2xx. */
export class OpenCodeUpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "OpenCodeUpstreamError";
    this.status = status;
    this.body = body;
  }
}
