/**
 * Harness-agnostic ACP Server process contract.
 *
 * Default implementation: `harnesses/opencode` (`opencode acp`).
 * A future Goose / Claude / Codex harness implements the same interface.
 */

import type { AcpConnection, SessionUpdateHandler } from "../acp/connection.js";

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
  start(): Promise<void>;
  stop(): Promise<void>;
  getConnection(): AcpConnection;
  setSessionUpdateHandler(handler: SessionUpdateHandler): void;
}
