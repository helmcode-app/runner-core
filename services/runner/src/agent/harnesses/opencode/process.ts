/**
 * Managed OpenCode ACP harness: install binary, spawn `opencode acp`, ACP stdio.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../../config.js";
import type { Logger } from "../../../logger.js";
import { runCommand } from "../../../util/process.js";
import {
  connectAcpClient,
  type AcpConnection,
  type SessionUpdateHandler,
} from "../../acp/connection.js";
import { AgentRuntimeError } from "../../errors.js";
import { materializeOpenCodeAuth, resolveOpenCodeHome } from "./auth.js";
import {
  isExecutable,
  isFloatingTag,
  openCodePackageSpec,
  pathExists,
  resolveOpenCodeBinaryPath,
  sleep,
} from "./binary.js";
import type { HarnessRuntime } from "../types.js";
import {
  resolveOpenCodeHarnessSettings,
  type OpenCodeHarnessSettings,
} from "./settings.js";

export {
  openCodePackageSpec,
  resolveOpenCodeBinaryPath,
} from "./binary.js";

export type ManagedHarnessState =
  | "idle"
  | "installing"
  | "starting"
  | "ready"
  | "updating"
  | "stopped"
  | "error";

export interface ManagedOpenCodeAcpStatus {
  state: ManagedHarnessState;
  managed: true;
  harness: "opencode";
  transport: "stdio";
  version?: string;
  desiredVersion: string;
  binaryPath: string;
  protocolVersion?: number;
  agentName?: string;
  error?: string;
  lastInstallAt?: string;
  lastUpdateCheckAt?: string;
}

/** Default ACP Server: install + spawn `opencode acp`. */
export class ManagedOpenCodeAcpRuntime implements HarnessRuntime {
  private child: ChildProcess | null = null;
  private connection: AcpConnection | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private state: ManagedHarnessState = "idle";
  private lastError: string | undefined;
  private installedVersion: string | undefined;
  private lastInstallAt: string | undefined;
  private lastUpdateCheckAt: string | undefined;
  private stopping = false;
  private op: Promise<void> = Promise.resolve();
  private onSessionUpdate: SessionUpdateHandler = () => undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly settings: OpenCodeHarnessSettings,
  ) {}

  get status(): ManagedOpenCodeAcpStatus {
    const status: ManagedOpenCodeAcpStatus = {
      state: this.state,
      managed: true,
      harness: "opencode",
      transport: "stdio",
      desiredVersion: this.settings.version,
      binaryPath: resolveOpenCodeBinaryPath(this.settings),
    };
    if (this.installedVersion !== undefined) {
      status.version = this.installedVersion;
    }
    if (this.connection) {
      status.protocolVersion = this.connection.protocolVersion;
      if (this.connection.agentName) {
        status.agentName = this.connection.agentName;
      }
    }
    if (this.lastError !== undefined) status.error = this.lastError;
    if (this.lastInstallAt !== undefined) {
      status.lastInstallAt = this.lastInstallAt;
    }
    if (this.lastUpdateCheckAt !== undefined) {
      status.lastUpdateCheckAt = this.lastUpdateCheckAt;
    }
    return status;
  }

  /** Wire ACP session/update fan-out before start(). */
  setSessionUpdateHandler(handler: SessionUpdateHandler): void {
    this.onSessionUpdate = handler;
  }

  getConnection(): AcpConnection {
    if (!this.connection) {
      throw new AgentRuntimeError("ACP connection not ready", 503);
    }
    return this.connection;
  }

  async start(): Promise<void> {
    await this.serialize(async () => {
      this.stopping = false;
      await materializeOpenCodeAuth(this.config, this.logger, this.settings);
      await this.ensureInstalled("boot");
      await this.startAcp();
      this.scheduleUpdates();
    });
  }

  async stop(): Promise<void> {
    await this.serialize(async () => {
      this.stopping = true;
      this.clearUpdateTimer();
      await this.killAcp();
      this.state = "stopped";
    });
  }

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
    const hours = this.settings.updateIntervalHours;
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
    const prefix = this.settings.prefix;
    const bin = resolveOpenCodeBinaryPath(this.settings);
    const spec = openCodePackageSpec(
      this.settings.version,
      this.settings.packageName,
    );
    const already = await isExecutable(bin);

    if (reason === "boot" && already) {
      this.installedVersion = await this.readBinaryVersion(bin);
      this.logger.info("opencode binary present", {
        bin,
        version: this.installedVersion,
        desired: this.settings.version,
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
      npm: this.settings.npmBin,
    });

    const result = await runCommand(
      this.settings.npmBin,
      ["install", "-g", "--prefix", prefix, spec],
      {
        cwd: prefix,
        timeoutMs: this.settings.installTimeoutMs,
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

  private async startAcp(): Promise<void> {
    if (this.child && !this.child.killed && this.connection) {
      return;
    }

    const bin = resolveOpenCodeBinaryPath(this.settings);
    if (!(await pathExists(bin))) {
      throw new Error(`opencode binary not found: ${bin}`);
    }

    this.state = "starting";
    const home = resolveOpenCodeHome(this.settings);
    const workDir = this.config.MAIN_REPO_PATH || home;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
    };

    this.logger.info("starting opencode acp", {
      bin,
      home,
      cwd: workDir,
    });

    const child = spawn(bin, ["acp"], {
      env,
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.logger.info("opencode acp", { stream: "stderr", line });
      }
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.connection = null;
      if (this.stopping) return;
      this.logger.error("opencode acp exited unexpectedly", { code, signal });
      this.state = "error";
      this.lastError = `acp exited (code=${code}, signal=${signal})`;
      setTimeout(() => {
        if (this.stopping) return;
        void this.serialize(async () => {
          if (this.stopping) return;
          try {
            await this.startAcp();
          } catch (err) {
            this.logger.error("opencode acp restart failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }, 2_000).unref();
    });

    child.on("error", (err) => {
      this.logger.error("opencode acp spawn error", { error: err.message });
      this.state = "error";
      this.lastError = err.message;
    });

    if (!child.stdin || !child.stdout) {
      throw new Error("opencode acp stdio pipes missing");
    }

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    // Brief wait so spawn failures surface before initialize.
    await sleep(100);
    if (this.child !== child) {
      throw new Error(
        `opencode acp died before connect: ${this.lastError ?? "unknown"}`,
      );
    }

    this.connection = await connectAcpClient({
      config: this.config,
      logger: this.logger,
      stream,
      onSessionUpdate: (params) => this.onSessionUpdate(params),
    });

    this.state = "ready";
    this.logger.info("opencode acp ready", {
      version: this.installedVersion,
      protocolVersion: this.connection.protocolVersion,
      agentName: this.connection.agentName,
    });
  }

  private async killAcp(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    if (conn) {
      try {
        await conn.close();
      } catch {
        /* ignore */
      }
    }

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
      if (child.exitCode !== null) done();
    });
    this.child = null;
  }

  private async runUpdateCycle(): Promise<void> {
    this.lastUpdateCheckAt = new Date().toISOString();
    this.logger.info("opencode update check", {
      desired: this.settings.version,
      current: this.installedVersion,
    });

    const before = this.installedVersion;
    await this.ensureInstalled("update");
    const after = this.installedVersion;

    if (
      before &&
      after &&
      before === after &&
      !isFloatingTag(this.settings.version)
    ) {
      this.logger.info("opencode already at desired version", {
        version: after,
      });
      this.state = "ready";
      return;
    }

    this.logger.info("restarting opencode acp after update", { before, after });
    await this.killAcp();
    await this.startAcp();
  }
}

export function createManagedOpenCodeAcpRuntime(
  config: AppConfig,
  logger: Logger,
  overlay?: Partial<OpenCodeHarnessSettings>,
): ManagedOpenCodeAcpRuntime | null {
  if (!config.SESSIONS_ENABLED || config.AGENT_HARNESS !== "opencode") {
    return null;
  }
  return new ManagedOpenCodeAcpRuntime(
    config,
    logger.child({ component: "opencode-acp" }),
    resolveOpenCodeHarnessSettings(overlay),
  );
}
