/**
 * Shared domain types for the HelmCode runner-core daemon.
 */

// ── Runtime ──────────────────────────────────────────────────────────────

/** Only open-core remains; commercial-saas pipeline mode was removed. */
export type HelmMode = "open-core";

// ── Process helpers ──────────────────────────────────────────────────────

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

// ── Open-core HTTP ───────────────────────────────────────────────────────

export interface HealthStatus {
  ok: true;
  mode: HelmMode;
  version: string;
  uptimeMs: number;
  sessionsEnabled: boolean;
}
