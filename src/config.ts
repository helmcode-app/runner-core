import { z } from "zod";
import type { HelmMode } from "./types.js";

const helmModeSchema = z.enum(["open-core", "commercial-saas"]);

const envSchema = z.object({
  HELM_MODE: helmModeSchema.default("open-core"),
  MAIN_REPO_PATH: z.string().min(1).default("/app/main_repo"),
  WORKSPACES_PATH: z.string().min(1).default("/app/workspaces"),
  /** 0 binds an ephemeral port (useful for tests). */
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  GATEWAY_URL: z.string().url().optional(),
  GATEWAY_TOKEN: z.string().optional(),
  WORKER_ID: z.string().optional(),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  LLM_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().min(1).default("gpt-4o"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GITHUB_TOKEN: z.string().optional(),
  GIT_USER_NAME: z.string().min(1).default("HelmCode Agent"),
  GIT_USER_EMAIL: z.string().email().default("agent@helmcode.app"),
  DEFAULT_BASE_BRANCH: z.string().min(1).default("main"),
  MAX_TEST_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
  /**
   * Default hard wall-clock budget per agent task (ms).
   * Overridden per-task via `timeoutMs`. 0 disables the default budget.
   */
  TASK_TIMEOUT_MS: z.coerce.number().int().min(0).default(900_000),
  /**
   * Bearer token for open-core HTTP API.
   * When set, all routes except GET /health require `Authorization: Bearer <token>`.
   * When unset, auth is disabled (local/dev only — log a warning at boot).
   */
  OPENCORE_API_TOKEN: z.string().optional(),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),
});

export type AppConfig = z.infer<typeof envSchema> & {
  mode: HelmMode;
  version: string;
};

function loadVersion(): string {
  return process.env.npm_package_version ?? "0.1.0";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const data = parsed.data;
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
