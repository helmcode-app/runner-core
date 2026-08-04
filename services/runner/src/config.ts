import { z } from "zod";
import type { HelmMode } from "./types.js";
import { envBool } from "./util/env.js";
import { isPlaceholderGithubToken } from "./util/github-token.js";

const helmModeSchema = z.enum(["open-core", "commercial-saas"]);

const envSchema = z.object({
  // ── Runtime mode ───────────────────────────────────────────
  HELM_MODE: helmModeSchema.default("open-core"),
  MAIN_REPO_PATH: z.string().min(1).default("/app/main_repo"),
  WORKSPACES_PATH: z.string().min(1).default("/app/workspaces"),
  /** 0 binds an ephemeral port (useful for tests). */
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // ── Commercial SaaS worker ─────────────────────────────────
  GATEWAY_URL: z.string().url().optional(),
  GATEWAY_TOKEN: z.string().optional(),
  WORKER_ID: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),

  // ── LLM ────────────────────────────────────────────────────
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().min(1).default("gpt-4o"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // ── Git ────────────────────────────────────────────────────
  GITHUB_TOKEN: z.string().optional(),
  GIT_USER_NAME: z.string().min(1).default("HelmCode Agent"),
  GIT_USER_EMAIL: z.string().email().default("agent@helmcode.app"),
  DEFAULT_BASE_BRANCH: z.string().min(1).default("main"),

  // ── Agent pipeline ─────────────────────────────────────────
  MAX_TEST_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * Default hard wall-clock budget per agent task (ms).
   * Overridden per-task via `timeoutMs`. 0 disables the default budget.
   */
  TASK_TIMEOUT_MS: z.coerce.number().int().min(0).default(900_000),

  // ── Open-core ingress auth ─────────────────────────────────
  /**
   * Bearer token for open-core HTTP + WebSocket APIs.
   * When set, all routes except GET /health require Bearer (or WS `?token=`).
   * When unset, auth is disabled (local/dev only — log a warning at boot).
   */
  OPENCORE_API_TOKEN: z.string().optional(),

  // ── VFS ────────────────────────────────────────────────────
  /** Absolute path to the helm-vfs binary (default: auto-resolve). */
  HELM_VFS_BIN: z.string().optional(),
  /** When true (default), open-core starts helm-vfs for WebSocket VFS gateway. */
  VFS_ENABLED: envBool(true),

  // ── Terminal (in-process PTY, no docker.sock) ──────────────
  /**
   * WebSSH via in-process PTY (node-pty).
   * Default false so unit tests / minimal boots stay quiet unless opted in.
   */
  TERMINAL_ENABLED: envBool(false),
  /** Shell binary or simple command string (default /bin/bash). */
  TERMINAL_SHELL: z.string().min(1).default("/bin/bash"),
  /** Working directory for the shell (default MAIN_REPO_PATH). */
  TERMINAL_WORKDIR: z.string().optional(),
  /** Max concurrent terminal sessions per runner process. */
  TERMINAL_MAX_SESSIONS: z.coerce.number().int().min(1).max(64).default(8),
  /** App-level heartbeat interval for terminal WS (ms). 0 disables. */
  TERMINAL_HEARTBEAT_MS: z.coerce.number().int().min(0).default(25_000),
});

export type AppConfig = z.infer<typeof envSchema> & {
  mode: HelmMode;
  version: string;
};

function loadVersion(): string {
  return process.env.npm_package_version ?? "0.1.0";
}

/** Compose often injects `KEY=` (empty string). Zod defaults only apply when the key is absent. */
function envWithEmptyAsUnset(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(out)) {
    if (value === "") {
      delete out[key];
    }
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(envWithEmptyAsUnset(env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const data = parsed.data;
  // Drop compose smoke placeholders so they never poison git Authorization.
  if (isPlaceholderGithubToken(data.GITHUB_TOKEN)) {
    delete (data as { GITHUB_TOKEN?: string }).GITHUB_TOKEN;
  }
  const mode = data.HELM_MODE;

  if (mode === "commercial-saas") {
    if (!data.GATEWAY_URL) {
      throw new Error("GATEWAY_URL is required when HELM_MODE=commercial-saas");
    }
  }

  return {
    ...data,
    mode,
    version: loadVersion(),
  };
}

export type { HelmMode };
