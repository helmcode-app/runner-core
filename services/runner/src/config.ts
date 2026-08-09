import { z } from "zod";
import type { HelmMode } from "./types.js";
import { envBool } from "./util/env.js";

const helmModeSchema = z.enum(["open-core"]);

const envSchema = z.object({
  // ── Runtime mode ───────────────────────────────────────────
  /** Only `open-core` is supported (legacy commercial-saas pipeline removed). */
  HELM_MODE: helmModeSchema.default("open-core"),
  MAIN_REPO_PATH: z.string().min(1).default("/app/main_repo"),
  WORKSPACES_PATH: z.string().min(1).default("/app/workspaces"),
  /** 0 binds an ephemeral port (useful for tests). */
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

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

  // ── Agent sessions runtime (adapter: OpenCode Server today) ─
  /**
   * When true, expose `/v1/sessions/*` via the session runtime adapter.
   * Default false so unit tests / minimal boots stay quiet.
   */
  OPENCODE_ENABLED: envBool(false),
  /**
   * When true (and OPENCODE_ENABLED), runner installs/starts `opencode serve`
   * at process boot and optionally refreshes on an interval.
   * When false, connect to an external daemon at OPENCODE_BASE_URL.
   */
  OPENCODE_MANAGED: envBool(false),
  /** Session runtime base URL (e.g. `opencode serve` on :4096). */
  OPENCODE_BASE_URL: z.string().url().default("http://127.0.0.1:4096"),
  /** Optional Basic auth password matching OPENCODE_SERVER_PASSWORD on the daemon. */
  OPENCODE_SERVER_PASSWORD: z.string().optional(),
  /** Basic auth username (default opencode). */
  OPENCODE_SERVER_USERNAME: z.string().min(1).default("opencode"),
  /** Non-SSE HTTP timeout to OpenCode (ms). */
  OPENCODE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Default model string for prompts (e.g. opencode/big-pickle). */
  OPENCODE_DEFAULT_MODEL: z.string().optional(),
  /**
   * Provider API key for managed OpenCode (OpenCode Go / Zen / etc.).
   * Written to `$OPENCODE_HOME/.local/share/opencode/auth.json` before serve starts.
   * Required when OPENCODE_MANAGED=true. Same path for local and cloud — no host mount.
   */
  OPENCODE_API_KEY: z.string().optional(),
  /**
   * Provider id stored in auth.json (must match model prefix, e.g. `opencode/...` → `opencode`).
   */
  OPENCODE_AUTH_PROVIDER: z.string().min(1).default("opencode"),
  /**
   * Home directory used for OpenCode auth/config when managed.
   * Default: process HOME / os.homedir(). Docker image uses /app for user helm.
   */
  OPENCODE_HOME: z.string().optional(),
  /** OpenCode agent name for mode=agent (default build). */
  OPENCODE_AGENT_NAME: z.string().optional(),
  /** OpenCode agent name for mode=plan (default plan). */
  OPENCODE_PLAN_AGENT: z.string().optional(),
  /** OpenCode agent name for mode=ask (default ask). */
  OPENCODE_ASK_AGENT: z.string().optional(),
  /**
   * npm dist-tag or semver for managed install (`opencode-ai@…`).
   * Use `latest` for rolling updates; pin for reproducibility.
   */
  OPENCODE_VERSION: z.string().min(1).default("latest"),
  /**
   * Install prefix for `npm install -g --prefix` (binary at `$PREFIX/bin/opencode`).
   * Must be writable by the runner user.
   */
  OPENCODE_PREFIX: z.string().min(1).default("/app/.opencode"),
  /** Override path to opencode binary (default `$OPENCODE_PREFIX/bin/opencode`). */
  OPENCODE_BIN: z.string().optional(),
  /** Hostname for managed `opencode serve` (loopback only by default). */
  OPENCODE_SERVE_HOSTNAME: z.string().min(1).default("127.0.0.1"),
  /** Port for managed `opencode serve` (should match OPENCODE_BASE_URL). */
  OPENCODE_SERVE_PORT: z.coerce.number().int().min(1).max(65535).default(4096),
  /**
   * Hours between managed update checks (`npm install` + restart).
   * 0 disables periodic updates (install still runs once at boot).
   */
  OPENCODE_UPDATE_INTERVAL_HOURS: z.coerce.number().min(0).default(24),
  /** Max time for a single npm install of opencode-ai (ms). */
  OPENCODE_INSTALL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(600_000),
  /** npm binary used for managed install (default `npm` on PATH). */
  OPENCODE_NPM_BIN: z.string().min(1).default("npm"),
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
  return {
    ...data,
    mode: data.HELM_MODE,
    version: loadVersion(),
  };
}

export type { HelmMode };
