/**
 * Managed stdio ACP supervisor for every catalog harness.
 *
 * npm packages install into `$prefix`. Cursor uses the official curl
 * installer into `~/.local/bin` (`agent` / `cursor-agent`). OpenCode
 * writes auth.json first, then uses the same install + spawn path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { runCommand } from "../../util/process.js";
import {
  connectAcpClient,
  type AcpConnection,
  type SessionUpdateHandler,
} from "../acp/connection.js";
import { AgentRuntimeError } from "../errors.js";
import {
  type AgentHarnessId,
  childAuthEnv,
  harnessSpec,
  type HarnessSpec,
} from "./catalog.js";
import {
  findOnPath,
  installCurlScript,
  installNpmPackage,
  isExecutable,
  isFloatingTag,
  npmPackageSpec,
  pathExists,
  resolveHarnessBinPath,
  sleep,
} from "./install.js";
import {
  materializeOpenCodeAuth,
  resolveOpenCodeHome,
} from "./opencode/auth.js";
import {
  resolveStdioHarnessSettings,
  type HarnessOverlay,
  type StdioHarnessSettings,
} from "./stdio-settings.js";
import type { HarnessModeIds, HarnessRuntime, HarnessStatus } from "./types.js";

export type ManagedStdioState =
  | "idle"
  | "installing"
  | "starting"
  | "ready"
  | "updating"
  | "stopped"
  | "error";

export interface ManagedStdioAcpStatus extends HarnessStatus {
  state: ManagedStdioState;
  managed: true;
  transport: "stdio";
  desiredVersion: string;
  lastInstallAt?: string;
  lastUpdateCheckAt?: string;
}

export class ManagedStdioAcpRuntime implements HarnessRuntime {
  private child: ChildProcess | null = null;
  private connection: AcpConnection | null = null;
  private updateTimer: NodeJS.Timeout | null = null;
  private state: ManagedStdioState = "idle";
  private lastError: string | undefined;
  private installedVersion: string | undefined;
  private lastInstallAt: string | undefined;
  private lastUpdateCheckAt: string | undefined;
  private stopping = false;
  private op: Promise<void> = Promise.resolve();
  private onSessionUpdate: SessionUpdateHandler = () => undefined;
  private resolvedBin: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly spec: HarnessSpec,
    private readonly settings: StdioHarnessSettings,
  ) {}

  get modes(): HarnessModeIds {
    return this.settings.modes;
  }

  get status(): ManagedStdioAcpStatus {
    const status: ManagedStdioAcpStatus = {
      state: this.state,
      managed: true,
      harness: this.spec.id,
      transport: "stdio",
      desiredVersion: this.settings.version,
      binaryPath: this.resolvedBin ?? this.preferredBinPath(),
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

  setSessionUpdateHandler(handler: SessionUpdateHandler): void {
    this.onSessionUpdate = handler;
  }

  getConnection(): AcpConnection {
    if (!this.connection) {
      throw new AgentRuntimeError("ACP connection not ready", 503);
    }
    return this.connection;
  }

  async start(opts?: { install?: boolean }): Promise<void> {
    await this.serialize(async () => {
      this.stopping = false;
      await this.prepareAuth();
      // Default: install. Boot path passes install:false so cold start stays quiet.
      await this.ensureInstalled(opts?.install === false ? "boot" : "configure");
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

  private async prepareAuth(): Promise<void> {
    if (this.spec.auth === "opencode-json") {
      await materializeOpenCodeAuth(this.config, this.logger, this.settings);
      return;
    }
    if (!this.settings.requireApiKey) return;
    if (this.config.AGENT_API_KEY?.trim()) return;
    const dest = this.spec.apiKeyEnv ?? "the harness process";
    throw new Error(
      `AGENT_API_KEY is required for AGENT_HARNESS=${this.spec.id} ` +
        `(injected as ${dest}). AGENT_PROVIDER is unused for this harness. ` +
        `Set requireApiKey: false on the harness overlay to reuse a local CLI login.`,
    );
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
    if (!this.settings.packageName) return;
    const hours = this.settings.updateIntervalHours;
    if (hours <= 0) {
      this.logger.info(`${this.spec.id} periodic update disabled`, {
        intervalHours: hours,
      });
      return;
    }
    const ms = hours * 60 * 60 * 1000;
    this.logger.info(`${this.spec.id} periodic update scheduled`, {
      intervalHours: hours,
    });
    this.updateTimer = setInterval(() => {
      void this.serialize(async () => {
        if (this.stopping) return;
        try {
          await this.runUpdateCycle();
        } catch (err) {
          this.logger.warn(`${this.spec.id} periodic update failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }, ms);
    this.updateTimer.unref();
  }

  private preferredBinPath(): string {
    return resolveHarnessBinPath(this.settings);
  }

  private async resolveBinary(): Promise<string> {
    if (this.settings.bin?.trim()) {
      return this.settings.bin.trim();
    }
    const prefixed = path.join(this.settings.prefix, "bin", this.settings.binName);
    if (await isExecutable(prefixed)) return prefixed;
    const fromPath = findOnPath(this.settings.pathCandidates);
    if (fromPath) return fromPath;
    return prefixed;
  }

  private canAutoInstall(): boolean {
    return Boolean(this.settings.packageName || this.settings.curlInstallUrl);
  }

  private async ensureInstalled(
    reason: "boot" | "configure" | "update",
  ): Promise<void> {
    this.resolvedBin = await this.resolveBinary();
    const already = await isExecutable(this.resolvedBin);

    if (already && reason === "boot") {
      this.installedVersion = await this.readBinaryVersion(this.resolvedBin);
      this.logger.info(`${this.spec.id} binary present`, {
        bin: this.resolvedBin,
        version: this.installedVersion,
        desired: this.settings.version,
      });
      return;
    }

    if (already && reason === "configure") {
      this.installedVersion = await this.readBinaryVersion(this.resolvedBin);
      this.logger.info(`${this.spec.id} binary present`, {
        bin: this.resolvedBin,
        version: this.installedVersion,
        desired: this.settings.version,
      });
      return;
    }

    if (already && reason === "update" && this.settings.curlInstallUrl) {
      await this.updateCurlInstalledBinary();
      return;
    }

    if (already && reason === "update" && !this.settings.packageName) {
      this.installedVersion = await this.readBinaryVersion(this.resolvedBin);
      return;
    }

    // Cold boot / resume: never download — wait for app Update (configure).
    if (reason === "boot") {
      const tried = this.settings.pathCandidates.join(", ");
      this.state = "error";
      this.lastError = `binary missing: ${this.resolvedBin} (PATH: ${tried})`;
      throw new Error(
        `${this.spec.id} CLI is not installed yet. Enable ACP in the app and tap Update to install it. ` +
          `Looked for: ${tried}`,
      );
    }

    if (!this.canAutoInstall()) {
      const tried = this.settings.pathCandidates.join(", ");
      this.state = "error";
      this.lastError = `binary missing: ${this.resolvedBin} (PATH: ${tried})`;
      throw new Error(
        `${this.spec.id} CLI not found. Install it or set the harness overlay \`bin\`. ` +
          `Looked for: ${tried}`,
      );
    }

    this.state = reason === "update" ? "updating" : "installing";
    this.lastError = undefined;

    if (this.settings.packageName) {
      await this.installViaNpm(reason);
      return;
    }

    await this.installViaCurl(reason);
  }

  private async installViaNpm(
    reason: "configure" | "update",
  ): Promise<void> {
    const packageName = this.settings.packageName;
    if (!packageName) {
      throw new Error(`${this.spec.id}: packageName missing for npm install`);
    }
    const spec = npmPackageSpec(packageName, this.settings.version);
    this.logger.info(`installing ${this.spec.id}`, {
      reason,
      kind: "npm",
      spec,
      prefix: this.settings.prefix,
      npm: this.settings.npmBin,
    });

    const result = await installNpmPackage({
      npmBin: this.settings.npmBin,
      prefix: this.settings.prefix,
      spec,
      timeoutMs: this.settings.installTimeoutMs,
    });

    this.resolvedBin = path.join(this.settings.prefix, "bin", this.settings.binName);
    if (!(await isExecutable(this.resolvedBin))) {
      this.state = "error";
      this.lastError = `binary missing after install: ${this.resolvedBin}`;
      throw new Error(this.lastError);
    }

    this.installedVersion = await this.readBinaryVersion(this.resolvedBin);
    this.lastInstallAt = new Date().toISOString();
    this.logger.info(`${this.spec.id} installed`, {
      bin: this.resolvedBin,
      version: this.installedVersion,
      durationMs: result.durationMs,
    });
  }

  private async installViaCurl(
    reason: "configure" | "update",
  ): Promise<void> {
    const url = this.settings.curlInstallUrl;
    if (!url) {
      throw new Error(`${this.spec.id}: curlInstallUrl missing`);
    }
    const home =
      this.settings.home?.trim() ||
      process.env.HOME?.trim() ||
      undefined;
    this.logger.info(`installing ${this.spec.id}`, {
      reason,
      kind: "curl",
      url,
      home: home ?? "(process default)",
    });

    const result = await installCurlScript({
      url,
      timeoutMs: this.settings.installTimeoutMs,
      ...(home ? { home } : {}),
    });

    this.resolvedBin = await this.resolveBinary();
    if (!(await isExecutable(this.resolvedBin))) {
      const tried = this.settings.pathCandidates.join(", ");
      this.state = "error";
      this.lastError =
        `binary missing after install (looked for: ${tried}). ` +
        `Installer finished but PATH may not include ~/.local/bin.`;
      throw new Error(this.lastError);
    }

    this.installedVersion = await this.readBinaryVersion(this.resolvedBin);
    this.lastInstallAt = new Date().toISOString();
    this.logger.info(`${this.spec.id} installed`, {
      bin: this.resolvedBin,
      version: this.installedVersion,
      durationMs: result.durationMs,
    });
  }

  /** Cursor CLI self-updates via `agent update`. */
  private async updateCurlInstalledBinary(): Promise<void> {
    const bin = this.resolvedBin;
    if (!bin) return;
    this.state = "updating";
    this.lastError = undefined;
    this.logger.info(`updating ${this.spec.id}`, { bin, kind: "self-update" });
    try {
      const result = await runCommand(bin, ["update"], {
        cwd: path.dirname(bin),
        timeoutMs: this.settings.installTimeoutMs,
        maxOutputChars: 128 * 1024,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(`${this.spec.id} self-update exited non-zero`, {
          exitCode: result.exitCode,
          stderr: result.stderr.trim().slice(0, 500),
        });
      }
    } catch (err) {
      this.logger.warn(`${this.spec.id} self-update failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.installedVersion = await this.readBinaryVersion(bin);
    this.lastInstallAt = new Date().toISOString();
    this.state = "ready";
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

    const bin = this.resolvedBin ?? (await this.resolveBinary());
    if (!(await pathExists(bin))) {
      throw new Error(`${this.spec.id} binary not found: ${bin}`);
    }
    this.resolvedBin = bin;

    this.state = "starting";
    const env = childAuthEnv(this.config, this.spec);
    if (this.spec.auth === "opencode-json") {
      env.HOME = resolveOpenCodeHome(this.settings);
    } else if (this.settings.home?.trim()) {
      env.HOME = this.settings.home.trim();
    }
    const workDir = this.config.MAIN_REPO_PATH.trim() || env.HOME || process.cwd();

    this.logger.info(`starting ${this.spec.id} acp`, {
      bin,
      args: this.settings.args,
      cwd: workDir,
      apiKeyEnv: this.spec.apiKeyEnv,
    });

    const child = spawn(bin, this.settings.args, {
      env,
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        this.logger.info(`${this.spec.id} acp`, { stream: "stderr", line });
      }
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      this.connection = null;
      if (this.stopping) return;
      this.logger.error(`${this.spec.id} acp exited unexpectedly`, {
        code,
        signal,
      });
      this.state = "error";
      this.lastError = `acp exited (code=${code}, signal=${signal})`;
      setTimeout(() => {
        if (this.stopping) return;
        void this.serialize(async () => {
          if (this.stopping) return;
          try {
            await this.startAcp();
          } catch (err) {
            this.logger.error(`${this.spec.id} acp restart failed`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }, 2_000).unref();
    });

    child.on("error", (err) => {
      this.logger.error(`${this.spec.id} acp spawn error`, { error: err.message });
      this.state = "error";
      this.lastError = err.message;
    });

    if (!child.stdin || !child.stdout) {
      throw new Error(`${this.spec.id} acp stdio pipes missing`);
    }

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    await sleep(100);
    if (this.child !== child) {
      throw new Error(
        `${this.spec.id} acp died before connect: ${this.lastError ?? "unknown"}`,
      );
    }

    this.connection = await connectAcpClient({
      config: this.config,
      logger: this.logger,
      stream,
      onSessionUpdate: (params) => this.onSessionUpdate(params),
    });

    this.state = "ready";
    this.logger.info(`${this.spec.id} acp ready`, {
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
    if (!this.canAutoInstall()) return;
    this.lastUpdateCheckAt = new Date().toISOString();
    this.logger.info(`${this.spec.id} update check`, {
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
      !isFloatingTag(this.settings.version) &&
      !this.settings.curlInstallUrl
    ) {
      this.logger.info(`${this.spec.id} already at desired version`, {
        version: after,
      });
      this.state = "ready";
      return;
    }

    // Curl CLIs self-update in place; restart ACP to pick up the new binary.
    if (before && after && before === after && this.settings.curlInstallUrl) {
      this.state = "ready";
      return;
    }

    this.logger.info(`restarting ${this.spec.id} acp after update`, {
      before,
      after,
    });
    await this.killAcp();
    await this.startAcp();
  }
}

export function createManagedStdioAcpRuntime(
  config: AppConfig,
  logger: Logger,
  harnessId: AgentHarnessId,
  overlay?: HarnessOverlay,
): ManagedStdioAcpRuntime | null {
  if (!config.SESSIONS_ENABLED) return null;
  const spec = harnessSpec(harnessId);
  return new ManagedStdioAcpRuntime(
    config,
    logger.child({ component: `${harnessId}-acp` }),
    spec,
    resolveStdioHarnessSettings(spec, overlay),
  );
}
