import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { isGitWorkTree } from "../agent/checkpoint.js";
import {
  formatSetupCodeMessage,
  generateSessionSecret,
  pairingPayload,
  pairingQrDataUrl,
} from "./codes.js";
import {
  activeDevices,
  approveEnrollment,
  countActiveDevices,
  createInvite,
  currentBootstrapCode,
  denyEnrollment,
  DeviceStoreError,
  enroll,
  issueBootstrap,
  issueBrowserGrant,
  listDeviceViews,
  loadDevicesSync,
  listPending,
  matchTokenSync,
  pollEnrollment,
  recoverDevices,
  hashSecret,
  revokeDevice,
  runnerIdOf,
  touchDevice,
  unlockBrowser,
  type EnrollResult,
} from "./devices.js";
import { readdir } from "node:fs/promises";
import type { WorkspaceRegistry } from "../workspaces/index.js";
import { cloneGithubRepo } from "./clone.js";
import {
  GithubDeviceFlow,
  listGithubRepos,
  type GithubRepo,
} from "./github.js";
import { resolveSetupSettings } from "./settings.js";
import {
  defaultSetupDir,
  loadSetupState,
  newSetupState,
  saveSetupState,
} from "./store.js";
import type {
  PairingTicket,
  SetupOperatorStatus,
  SetupPublicStatus,
  SetupState,
} from "./types.js";

const ENROLL_FAIL_LIMIT = 8;
const ENROLL_FAIL_WINDOW_MS = 10 * 60 * 1000;
const WS_TICKET_TTL_MS = 60 * 1000;

export class SetupController {
  private state: SetupState;
  private readonly operators = new Set<string>();
  private readonly tickets = new Map<string, number>();
  private readonly enrollFailures = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly lastTouch = new Map<string, number>();
  private mutation: Promise<unknown> = Promise.resolve();
  private github: GithubDeviceFlow | null = null;
  private readonly dir: string;
  private hasRepo: boolean;
  private readonly workspaces: WorkspaceRegistry;

  private constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    state: SetupState,
    dir: string,
    hasRepo: boolean,
    workspaces: WorkspaceRegistry,
  ) {
    this.state = state;
    this.dir = dir;
    this.hasRepo = hasRepo;
    this.workspaces = workspaces;
  }

  static async create(
    config: AppConfig,
    logger: Logger,
    opts: { quiet?: boolean; workspaces: WorkspaceRegistry },
  ): Promise<SetupController> {
    const dir = defaultSetupDir(config.WORKSPACES_PATH);
    const log = logger.child({ component: "setup" });
    const existing = await loadSetupState(dir);
    const git = await isGitWorkTree(config.MAIN_REPO_PATH);
    const workspaces = opts.workspaces;
    if (git && existing?.repo) {
      workspaces.setPrimaryRepo(existing.repo);
    }

    let state: SetupState;
    let hasRepo = git || workspaces.list().some((w) => w.id !== "default");
    if (existing?.phase === "ready" || existing?.paired || existing?.github) {
      state = existing;
      if (!git && state.github?.accessToken && state.repo) {
        log.info("worktree missing; re-cloning", {
          repo: `${state.repo.owner}/${state.repo.repo}`,
        });
        try {
          await cloneGithubRepo({
            dest: config.MAIN_REPO_PATH,
            owner: state.repo.owner,
            repo: state.repo.repo,
            accessToken: state.github.accessToken,
          });
          hasRepo = true;
          workspaces.setPrimaryRepo(state.repo);
          state = {
            ...state,
            phase: "ready",
            updatedAt: new Date().toISOString(),
          };
          await saveSetupState(dir, state);
        } catch (err) {
          log.warn("re-clone failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          if (!hasRepo) {
            state = {
              ...state,
              phase: "clone",
              updatedAt: new Date().toISOString(),
            };
            await saveSetupState(dir, state);
          }
        }
      } else if (!hasRepo && state.phase === "ready") {
        state = {
          ...state,
          phase: state.github?.accessToken ? "clone" : "github",
          updatedAt: new Date().toISOString(),
        };
        await saveSetupState(dir, state);
      }
      log.info("setup restored", { phase: state.phase, hasRepo });
    } else {
      state = newSetupState("pairing");
      await saveSetupState(dir, state);
      log.info("setup pairing required", { hasRepo });
    }

    if (state.apiToken || state.claim) {
      const next: SetupState = { ...state, updatedAt: now() };
      delete next.apiToken;
      delete next.claim;
      state = next;
      await saveSetupState(dir, state);
    }

    const ctl = new SetupController(
      config,
      log,
      state,
      dir,
      hasRepo,
      workspaces,
    );
    const fresh = await ctl.ensureBootstrapCode();
    if (fresh && !opts.quiet) ctl.printSetupCode(fresh, "enroll");
    return ctl;
  }

  async publicStatus(): Promise<SetupPublicStatus> {
    const paired = (await countActiveDevices(this.dir)) > 0;
    return { paired, authRequired: true };
  }

  operatorStatus(extra?: { workspaceId?: string }): SetupOperatorStatus {
    const paired =
      activeDevices(loadDevicesSync(this.dir)).length > 0;
    return {
      phase: this.state.phase,
      githubConfigured: Boolean(resolveSetupSettings().githubClientId),
      ...(this.state.github?.login
        ? { githubLogin: this.state.github.login }
        : {}),
      ...(this.state.repo
        ? { repo: { owner: this.state.repo.owner, repo: this.state.repo.repo } }
        : {}),
      hasRepo:
        this.hasRepo ||
        this.workspaces.list().some(
          (row) => row.id !== "default" || Boolean(row.repo),
        ),
      paired,
      workspaces: this.workspaces.list().map((row) => ({
        id: row.id,
        path: row.path,
        kind: row.kind,
        ...(row.repo
          ? { repo: { owner: row.repo.owner, repo: row.repo.repo } }
          : {}),
      })),
      ...(extra?.workspaceId ? { workspaceId: extra.workspaceId } : {}),
    };
  }

  authorizeDevice(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const token = header.slice("Bearer ".length).trim();
    const device = matchTokenSync(this.dir, token);
    if (!device) return false;
    this.noteSeen(device.id);
    return true;
  }

  authorizeUpgrade(req: IncomingMessage, url: URL): boolean {
    if (this.authorizeDevice(req)) return true;
    const ticket = url.searchParams.get("ticket")?.trim();
    if (!ticket) return false;
    return this.redeemTicket(ticket);
  }

  isOperator(req: IncomingMessage): boolean {
    if (this.authorizeDevice(req)) return true;
    const cookie = readCookie(req, "helm_setup");
    return Boolean(cookie && this.operators.has(cookie));
  }

  async ensureBootstrapCode(): Promise<string | undefined> {
    if ((await countActiveDevices(this.dir)) > 0) return undefined;
    if (await currentBootstrapCode(this.dir)) return undefined;
    return issueBootstrap(this.dir, "bootstrap");
  }

  async printEnrollCode(): Promise<string> {
    const code = await issueBootstrap(this.dir, "bootstrap");
    process.stdout.write(formatSetupCodeMessage(code, "enroll"));
    return code;
  }

  async printRecoverCode(): Promise<string> {
    const code = await recoverDevices(this.dir);
    process.stdout.write(formatSetupCodeMessage(code, "recover"));
    return code;
  }

  async printBrowserCode(): Promise<string> {
    return issueBrowserGrant(this.dir);
  }

  async enrollDevice(
    req: IncomingMessage,
    code: string,
    deviceName: string,
  ): Promise<EnrollResult> {
    this.assertEnrollRate(req);
    try {
      const result = await this.mutate(() => enroll(this.dir, code, deviceName));
      if (result.status === "complete") await this.markPaired();
      this.clearEnrollFailures(req);
      return result;
    } catch (err) {
      this.noteEnrollFailure(req);
      throw this.asHttp(err);
    }
  }

  async inviteDevice(url?: string): Promise<PairingTicket> {
    const safeURL = httpURL(url);
    try {
      const invite = await this.mutate(() =>
        safeURL ? createInvite(this.dir, safeURL) : createInvite(this.dir),
      );
      const qrPayload = invite.url
        ? pairingPayload(invite.url, invite.code)
        : invite.code;
      return {
        code: invite.code,
        expiresAt: invite.expiresAt,
        qrPayload,
        qrDataUrl: await pairingQrDataUrl(qrPayload),
      };
    } catch (err) {
      throw this.asHttp(err);
    }
  }

  async pendingEnrollments() {
    return listPending(this.dir);
  }

  async approve(enrollmentId: string) {
    try {
      const approved = await this.mutate(() =>
        approveEnrollment(this.dir, enrollmentId),
      );
      await this.markPaired();
      return approved;
    } catch (err) {
      throw this.asHttp(err);
    }
  }

  async deny(enrollmentId: string): Promise<void> {
    try {
      await this.mutate(() => denyEnrollment(this.dir, enrollmentId));
    } catch (err) {
      throw this.asHttp(err);
    }
  }

  async poll(enrollmentId: string) {
    try {
      return await this.mutate(() => pollEnrollment(this.dir, enrollmentId));
    } catch (err) {
      throw this.asHttp(err);
    }
  }

  async devices(req: IncomingMessage) {
    const current = this.currentDeviceId(req);
    return listDeviceViews(this.dir, current);
  }

  async revoke(id: string): Promise<void> {
    try {
      await this.mutate(() => revokeDevice(this.dir, id));
    } catch (err) {
      throw this.asHttp(err);
    }
  }

  async unlockBrowser(req: IncomingMessage, code: string): Promise<string> {
    this.assertEnrollRate(req);
    const ok = await unlockBrowser(this.dir, code);
    if (!ok) {
      this.noteEnrollFailure(req);
      throw new SetupHttpError(400, "invalid or expired setup code");
    }
    this.clearEnrollFailures(req);
    const secret = generateSessionSecret();
    this.operators.add(secret);
    return secret;
  }

  issueWsTicket(): { ticket: string; expiresAt: number } {
    this.pruneTickets();
    const ticket = randomTicket();
    const expiresAt = Date.now() + WS_TICKET_TTL_MS;
    this.tickets.set(hashSecret(ticket), expiresAt);
    return { ticket, expiresAt };
  }

  async runnerId(): Promise<string> {
    return runnerIdOf(this.dir);
  }

  async startGithub(): Promise<{
    userCode: string;
    verificationUri: string;
    expiresAt: number;
    intervalMs: number;
  }> {
    const clientId = resolveSetupSettings().githubClientId;
    if (!clientId) {
      throw new SetupHttpError(
        501,
        "GitHub OAuth is not configured (set GITHUB_CLIENT_ID or SETUP_SETTINGS_OVERLAY.githubClientId)",
      );
    }
    this.github = new GithubDeviceFlow(clientId);
    const started = await this.github.start();
    if (this.state.phase === "pairing") {
      this.state = { ...this.state, phase: "github", updatedAt: now() };
      await this.persist();
    }
    return {
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      expiresAt: started.expiresAt,
      intervalMs: started.intervalMs,
    };
  }

  async pollGithub(): Promise<{
    status: string;
    login?: string;
    intervalMs?: number;
    error?: string;
  }> {
    if (!this.github)
      throw new SetupHttpError(400, "GitHub device flow not started");
    const result = await this.github.poll();
    if (result.status === "complete") {
      this.state = {
        ...this.state,
        phase: "clone",
        github: {
          login: result.user.login,
          accessToken: result.user.accessToken,
        },
        updatedAt: now(),
      };
      await this.persist();
      return { status: "complete", login: result.user.login };
    }
    if (result.status === "pending") {
      return { status: "pending", intervalMs: result.intervalMs };
    }
    return { status: result.status, error: result.error };
  }

  async listRepos(): Promise<GithubRepo[]> {
    const token = this.state.github?.accessToken;
    if (!token) throw new SetupHttpError(400, "GitHub is not linked");
    return listGithubRepos(token);
  }

  async cloneRepo(input: {
    owner: string;
    repo: string;
    ref?: string;
  }): Promise<{ workspaceId: string }> {
    const token = this.state.github?.accessToken;
    if (!token) throw new SetupHttpError(400, "GitHub is not linked");
    const owner = input.owner.trim();
    const repo = input.repo.trim();
    if (!owner || !repo)
      throw new SetupHttpError(400, "owner and repo required");

    const existing = this.workspaces.findByRepo(owner, repo);
    if (existing) {
      throw new SetupHttpError(
        409,
        `repository already on this runner (${existing.id})`,
      );
    }

    const mainIsGit = await isGitWorkTree(this.config.MAIN_REPO_PATH);
    const mainEmpty = await isDirUsableForClone(this.config.MAIN_REPO_PATH);
    let workspaceId: string;
    let dest: string;

    if (!mainIsGit && mainEmpty) {
      workspaceId = "default";
      dest = this.config.MAIN_REPO_PATH;
    } else {
      const target = this.workspaces.projectPathFor(owner, repo);
      workspaceId = target.id;
      dest = target.path;
      if (this.workspaces.list().some((row) => row.id === workspaceId)) {
        throw new SetupHttpError(
          409,
          `workspace already registered: ${workspaceId}`,
        );
      }
    }

    await cloneGithubRepo({
      dest,
      owner,
      repo,
      accessToken: token,
      ...(input.ref?.trim() ? { ref: input.ref.trim() } : {}),
    });

    if (workspaceId === "default") {
      this.workspaces.setPrimaryRepo({ owner, repo });
      this.state = {
        ...this.state,
        phase: "ready",
        repo: { owner, repo },
        updatedAt: now(),
      };
    } else {
      await this.workspaces.addProject({ id: workspaceId, path: dest, owner, repo });
      this.state = {
        ...this.state,
        phase: "ready",
        ...(this.state.repo ? {} : { repo: { owner, repo } }),
        updatedAt: now(),
      };
    }
    this.hasRepo = true;
    await this.persist();
    this.logger.info("repository cloned", {
      repo: `${owner}/${repo}`,
      workspaceId,
      dest,
    });
    return { workspaceId };
  }

  private async markPaired(): Promise<void> {
    if (this.state.phase !== "pairing" && this.state.paired) return;
    const nextPhase =
      this.state.phase === "pairing"
        ? this.hasRepo
          ? "ready"
          : "github"
        : this.state.phase;
    this.state = {
      ...this.state,
      phase: nextPhase,
      paired: true,
      updatedAt: now(),
    };
    delete this.state.claim;
    delete this.state.apiToken;
    await this.persist();
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(fn, fn);
    this.mutation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private printSetupCode(code: string, kind: "enroll" | "recover"): void {
    if (process.env.NODE_TEST_CONTEXT) return;
    process.stderr.write(formatSetupCodeMessage(code, kind));
  }

  private noteSeen(id: string): void {
    const seen = this.lastTouch.get(id) ?? 0;
    if (Date.now() - seen < 60_000) return;
    this.lastTouch.set(id, Date.now());
    void touchDevice(this.dir, id).catch(() => undefined);
  }

  private currentDeviceId(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return undefined;
    return matchTokenSync(
      this.dir,
      header.slice("Bearer ".length).trim(),
    )?.id;
  }

  private redeemTicket(ticket: string): boolean {
    this.pruneTickets();
    const key = hashSecret(ticket);
    const expiresAt = this.tickets.get(key);
    if (!expiresAt || expiresAt <= Date.now()) return false;
    this.tickets.delete(key);
    return true;
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.tickets) {
      if (expiresAt <= now) this.tickets.delete(key);
    }
  }

  private clientKey(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown";
  }

  private assertEnrollRate(req: IncomingMessage): void {
    const row = this.enrollFailures.get(this.clientKey(req));
    if (row && row.resetAt > Date.now() && row.count >= ENROLL_FAIL_LIMIT) {
      throw new SetupHttpError(429, "too many attempts");
    }
  }

  private noteEnrollFailure(req: IncomingMessage): void {
    const key = this.clientKey(req);
    const current = this.enrollFailures.get(key);
    const now = Date.now();
    if (!current || current.resetAt <= now) {
      this.enrollFailures.set(key, {
        count: 1,
        resetAt: now + ENROLL_FAIL_WINDOW_MS,
      });
      return;
    }
    current.count += 1;
  }

  private clearEnrollFailures(req: IncomingMessage): void {
    this.enrollFailures.delete(this.clientKey(req));
  }

  private asHttp(err: unknown): Error {
    if (err instanceof DeviceStoreError) {
      return new SetupHttpError(err.status, err.message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private async persist(): Promise<void> {
    await saveSetupState(this.dir, this.state);
  }
}

export class SetupHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SetupHttpError";
  }
}

/** True when dest is missing or only contains ignorable leftovers. */
async function isDirUsableForClone(dest: string): Promise<boolean> {
  let names: string[] = [];
  try {
    names = await readdir(dest);
  } catch {
    return true;
  }
  return (
    names.filter((n) => n !== ".DS_Store" && n !== "lost+found").length === 0
  );
}

function now(): string {
  return new Date().toISOString();
}

function randomTicket(): string {
  return randomBytes(24).toString("base64url");
}

function httpURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
