/**
 * Managed OpenCode lifecycle: install at boot, spawn `opencode serve`,
 * optional periodic upgrade + restart.
 *
 * Only used when OPENCODE_ENABLED && OPENCODE_MANAGED.
 * External daemons (OPENCODE_MANAGED=false) are unaffected.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { runCommand } from "../util/process.js";
import { materializeOpenCodeAuth, resolveOpenCodeHome } from "./auth.js";
import { OpenCodeClient } from "./client.js";

const OPENCODE_PACKAGE = "opencode-ai";

export type ManagedRuntimeState =
  | "idle"
  | "installing"
  | "starting"
  | "ready"
  | "updating"
  | "stopped"
  | "error";

export interface ManagedOpenCodeStatus {
  state: ManagedRuntimeState;
  managed: true;
  version?: string;
  desiredVersion: string;
  binaryPath: string;
  baseUrl: string;
  error?: string;
  lastInstallAt?: string;
  lastUpdateCheckAt?: string;
}

export function resolveOpenCodeBinaryPath(config: AppConfig): string {
  if (config.OPENCODE_BIN?.trim()) {
    return config.OPENCODE_BIN.trim();
  }
  return path.join(config.OPENCODE_PREFIX, "bin", "opencode");
}

export function openCodePackageSpec(version: string): string {
  const v = version.trim() || "latest";
  return `${OPENCODE_PACKAGE}@${v}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class ManagedOpenCodeRuntime {
  private child: ChildProcess | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private state: ManagedRuntimeState = "idle";
  private lastError: string | undefined;
  private installedVersion: string | undefined;
  private lastInstallAt: string | undefined;
  private lastUpdateCheckAt: string | undefined;
  private stopping = false;
  private op: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  get status(): ManagedOpenCodeStatus {
    return {
      state: this.state,
      managed: true,
      desiredVersion: this.config.OPENCODE_VERSION,
      binaryPath: resolveOpenCodeBinaryPath(this.config),
      baseUrl: this.config.OPENCODE_BASE_URL.replace(/\/+$/, ""),
      ...(this.installedVersion !== undefined
        ? { version: this.installedVersion }
        : {}),
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
      ...(this.lastInstallAt !== undefined
        ? { lastInstallAt: this.lastInstallAt }
        : {}),
      ...(this.lastUpdateCheckAt !== undefined
        ? { lastUpdateCheckAt: this.lastUpdateCheckAt }
        : {}),
    };
  }

  /**
   * Install (if needed) + start serve + schedule periodic updates.
   * Throws on hard failure so open-core boot fails visibly.
   */
  async start(): Promise<void> {
    await this.serialize(async () => {
      this.stopping = false;
      // Same as production: API key from env → auth.json (no host mount).
      await materializeOpenCodeAuth(this.config, this.logger);
      await this.ensureInstalled("boot");
      await this.startServe();
      this.scheduleUpdates();
    });
  }

  async stop(): Promise<void> {
    await this.serialize(async () => {
      this.stopping = true;
      this.clearUpdateTimer();
      await this.killServe();
      this.state = "stopped";
    });
  }

  /** Force an update check (used by tests / future admin routes). */
  async checkForUpdate(): Promise<void> {
    await this.serialize(async () => {
      await this.runUpdateCycle();
    });
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.op.then(fn, fn);
    this.op = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private clearUpdateTimer(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private scheduleUpdates(): void {
    this.clearUpdateTimer();
    const hours = this.config.OPENCODE_UPDATE_INTERVAL_HOURS;
    if (hours <= 0) {
      this.logger.info("opencode periodic update disabled", {
        intervalHours: hours,
      });
      return;
    }
    const ms = hours * 60 * 60 * 1000;
    this.logger.info("opencode periodic update scheduled", {
      intervalHours: hours,
    });
    this.updateTimer = setInterval(() => {
      void this.serialize(async () => {
        if (this.stopping) return;
        try {
          await this.runUpdateCycle();
        } catch (err) {
          this.logger.warn("opencode periodic update failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }, ms);
    this.updateTimer.unref();
  }

  private async ensureInstalled(reason: "boot" | "update"): Promise<void> {
    const prefix = this.config.OPENCODE_PREFIX;
    const bin = resolveOpenCodeBinaryPath(this.config);
    const spec = openCodePackageSpec(this.config.OPENCODE_VERSION);
    const already = await isExecutable(bin);

    // Boot: install only when missing. Periodic updates reinstall (e.g. @latest).
    if (reason === "boot" && already) {
      this.installedVersion = await this.readBinaryVersion(bin);
      this.logger.info("opencode binary present", {
        bin,
        version: this.installedVersion,
        desired: this.config.OPENCODE_VERSION,
      });
      return;
    }

    this.state = reason === "update" ? "updating" : "installing";
    this.lastError = undefined;
    await mkdir(prefix, { recursive: true });

    this.logger.info("installing opencode", {
      reason,
      spec,
      prefix,
      npm: this.config.OPENCODE_NPM_BIN,
    });

    const result = await runCommand(
      this.config.OPENCODE_NPM_BIN,
      ["install", "-g", "--prefix", prefix, spec],
      {
        cwd: prefix,
        timeoutMs: this.config.OPENCODE_INSTALL_TIMEOUT_MS,
        maxOutputChars: 256 * 1024,
        env: {
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
        },
      },
    );

    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      this.state = "error";
      this.lastError = detail;
      throw new Error(`Failed to install ${spec}: ${detail}`);
    }

    if (!(await isExecutable(bin))) {
      this.state = "error";
      this.lastError = `binary missing after install: ${bin}`;
      throw new Error(this.lastError);
    }

    this.installedVersion = await this.readBinaryVersion(bin);
    this.lastInstallAt = new Date().toISOString();
    this.logger.info("opencode installed", {
      bin,
      version: this.installedVersion,
      durationMs: result.durationMs,
    });
  }

  private async readBinaryVersion(bin: string): Promise<string | undefined> {
    try {
      const result = await runCommand(bin, ["--version"], {
        cwd: path.dirname(bin),
        timeoutMs: 15_000,
        maxOutputChars: 4096,
      });
      if (result.exitCode !== 0) return undefined;
      const line = result.stdout.trim().split(/\r?\n/)[0]?.trim();
      return line || undefined;
    } catch {
      return undefined;
    }
  }

  private async startServe(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }

    const bin = resolveOpenCodeBinaryPath(this.config);
    if (!(await pathExists(bin))) {
      throw new Error(`opencode binary not found: ${bin}`);
    }

    this.state = "starting";
    const hostname = this.config.OPENCODE_SERVE_HOSTNAME;
    const port = this.config.OPENCODE_SERVE_PORT;
    const args = ["serve", "--hostname", hostname, "--port", String(port)];

    const home = resolveOpenCodeHome(this.config);
    // Project root for OpenCode sessions (must be a real repo). Auth still uses HOME.
    const workDir = this.config.MAIN_REPO_PATH || home;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Ensure serve reads the auth.json we just wrote under this home.
      HOME: home,
    };
    if (this.config.OPENCODE_SERVER_PASSWORD) {
      env.OPENCODE_SERVER_PASSWORD = this.config.OPENCODE_SERVER_PASSWORD;
    }
    if (this.config.OPENCODE_SERVER_USERNAME) {
      env.OPENCODE_SERVER_USERNAME = this.config.OPENCODE_SERVER_USERNAME;
    }

    this.logger.info("starting opencode serve", {
      bin,
      hostname,
      port,
      home,
      cwd: workDir,
    });

    const child = spawn(bin, args, {
      env,
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // OpenCode logs to stdout/stderr — surface at info so docker compose logs show turns.
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.logger.info("opencode serve", { stream: "stdout", line });
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.logger.info("opencode serve", { stream: "stderr", line });
      }
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      this.logger.error("opencode serve exited unexpectedly", {
        code,
        signal,
      });
      this.state = "error";
      this.lastError = `serve exited (code=${code}, signal=${signal})`;
      // Best-effort restart after a short delay.
      setTimeout(() => {
        if (this.stopping) return;
        void this.serialize(async () => {
          if (this.stopping) return;
          try {
            await this.startServe();
          } catch (err) {
            this.logger.error("opencode serve restart failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }, 2_000).unref();
    });

    child.on("error", (err) => {
      this.logger.error("opencode serve spawn error", { error: err.message });
      this.state = "error";
      this.lastError = err.message;
    });

    await this.waitUntilHealthy();
    this.state = "ready";
    this.logger.info("opencode serve ready", {
      baseUrl: this.config.OPENCODE_BASE_URL,
      version: this.installedVersion,
    });
  }

  private async waitUntilHealthy(): Promise<void> {
    const client = new OpenCodeClient({
      baseUrl: this.config.OPENCODE_BASE_URL,
      timeoutMs: 5_000,
      ...(this.config.OPENCODE_SERVER_PASSWORD
        ? {
            basicAuth: {
              username: this.config.OPENCODE_SERVER_USERNAME || "opencode",
              password: this.config.OPENCODE_SERVER_PASSWORD,
            },
          }
        : {}),
    });

    const deadline = Date.now() + 60_000;
    let lastErr = "timeout";
    while (Date.now() < deadline) {
      if (this.child === null) {
        throw new Error(`opencode serve died before healthy: ${this.lastError ?? lastErr}`);
      }
      try {
        const h = await client.health();
        if (h.healthy) return;
        lastErr = "health returned not healthy";
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await sleep(500);
    }
    throw new Error(`opencode serve not healthy within 60s: ${lastErr}`);
  }

  private async killServe(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return;
    }
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000).unref();
      // If already exited
      if (child.exitCode !== null) done();
    });
    this.child = null;
  }

  private async runUpdateCycle(): Promise<void> {
    this.lastUpdateCheckAt = new Date().toISOString();
    this.logger.info("opencode update check", {
      desired: this.config.OPENCODE_VERSION,
      current: this.installedVersion,
    });

    const before = this.installedVersion;
    await this.ensureInstalled("update");
    const after = this.installedVersion;

    if (before && after && before === after && !isFloatingTag(this.config.OPENCODE_VERSION)) {
      this.logger.info("opencode already at desired version", { version: after });
      this.state = "ready";
      return;
    }

    // Restart serve to pick up new binary (even if --version string matches for @latest).
    this.logger.info("restarting opencode serve after update", {
      before,
      after,
    });
    await this.killServe();
    await this.startServe();
  }
}

function isFloatingTag(version: string): boolean {
  const v = version.trim().toLowerCase();
  return v === "latest" || v === "next" || v === "beta" || v === "dev" || v.startsWith("latest-");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Factory: only when sessions + managed mode are on. */
export function createManagedOpenCodeRuntime(
  config: AppConfig,
  logger: Logger,
): ManagedOpenCodeRuntime | null {
  if (!config.OPENCODE_ENABLED || !config.OPENCODE_MANAGED) return null;
  return new ManagedOpenCodeRuntime(
    config,
    logger.child({ component: "opencode-runtime" }),
  );
}
