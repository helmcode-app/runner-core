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

export interface HarnessRuntime {
  readonly status: HarnessStatus;
  /** Product mode → advertised ACP mode id. */
  readonly modes: HarnessModeIds;
  start(): Promise<void>;
  stop(): Promise<void>;
  getConnection(): AcpConnection;
  setSessionUpdateHandler(handler: SessionUpdateHandler): void;
}
