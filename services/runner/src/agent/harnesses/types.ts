/**
 * Harness-agnostic ACP Server process contract.
 *
 * One implementation: `stdio.ts`, driven by `catalog.ts`.
 * OpenCode-only leftover is `opencode/auth.ts` (auth.json).
 */

import type { AcpConnection, SessionUpdateHandler } from "../acp/connection.js";

export interface HarnessModeIds {
  agent: string;
  plan: string;
  ask: string;
}

export interface HarnessStatus {
  state: string;
  managed: boolean;
  harness: string;
  transport: string;
  version?: string;
  desiredVersion?: string;
  binaryPath?: string;
  protocolVersion?: number;
  agentName?: string;
  error?: string;
}

export interface HarnessStartOptions {
  /**
   * When true, missing CLIs are auto-installed (npm / curl).
   * Product: only `PUT /v1/agent` (Update) sets this. Runner boot resumes an
   * already-installed binary and does not download on cold start.
   */
  install?: boolean;
}

export interface HarnessRuntime {
  readonly status: HarnessStatus;
  /** Product mode → advertised ACP mode id. */
  readonly modes: HarnessModeIds;
  start(opts?: HarnessStartOptions): Promise<void>;
  stop(): Promise<void>;
  getConnection(): AcpConnection;
  setSessionUpdateHandler(handler: SessionUpdateHandler): void;
}
