import { z } from "zod";
import { AGENT_HARNESS_IDS } from "./agent/harnesses/ids.js";
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

 // ── Agent sessions (ACP Client → harness ACP Server) ───────
 /**
  * Bootstrap only: when true and no `$WORKSPACES_PATH/.setup/agent.json`,
  * start ACP from the AGENT_* env values below.
  * Product path is PUT /v1/agent (persisted file). Default false.
  */
 SESSIONS_ENABLED: envBool(false),
 /**
  * Bootstrap harness when SESSIONS_ENABLED and no agent.json.
  * Runtime switching uses PUT /v1/agent.
  */
 AGENT_HARNESS: z.enum(AGENT_HARNESS_IDS).default("opencode"),
 /**
  * Bootstrap LLM vendor inside OpenCode when no agent.json.
  * Unused for single-vendor harnesses.
  */
 AGENT_PROVIDER: z.enum(["opencode-go", "opencode-go-plus"]).optional(),
 /**
  * Bootstrap API key when no agent.json.
  * Prefer PUT /v1/agent so the key lands in agent.json (mode 0600).
  */
 AGENT_API_KEY: z.string().optional(),
 /**
  * Bootstrap default model when no agent.json.
  */
 AGENT_DEFAULT_MODEL: z.string().optional(),
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
