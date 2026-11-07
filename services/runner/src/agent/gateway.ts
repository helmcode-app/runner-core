/**
 * Agent Gateway: product `/v1/sessions` semantics over an ACP Client connection.
 */

import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  AgentSession,
  PromptAccepted,
  PromptRequest,
  RewindResponse,
  SessionMode,
  SessionStatus,
  SessionStreamEvent,
  SessionUsage,
  TimelineEntry,
} from "../sessions/types.js";
import { maybeTitleFromTimeline } from "../sessions/title.js";
import type { AcpConnection } from "./acp/connection.js";
import {
  captureWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from "./checkpoint.js";
import { AgentNotFoundError, AgentRuntimeError } from "./errors.js";
import type { HarnessRuntime } from "./harnesses/types.js";
import {
  DEFAULT_CONTEXT_SIZE,
  mapAcpSessionUpdate,
  mapStopReason,
  usageFromPromptResult,
} from "./map-updates.js";
import {
  fastSetConfig,
  modelIdsFromConfigOptions,
  modelSetConfig,
  parseConfigOptions,
  thinkLevelSetConfig,
  type HelmConfigOption,
  type SetConfigPayload,
} from "./session-config.js";
import { loadAgentModelsCatalog, type ModelsCatalog } from "./models.js";
import {
  formatSeedContext,
  parseRewindRestore,
  planRewind,
  type RewindRestore,
  type SessionCheckpoint,
} from "./rewind.js";
import { SessionStore, defaultSessionsDir } from "./persist.js";
import { resolveAgentSettings } from "./settings.js";
import { type WorkspaceRegistry } from "../workspaces/index.js";

export interface GatewaySessionRecord {
  helmId: string;
  /** Empty after process restart until the next prompt rebuilds ACP. */
  acpSessionId: string;
  cwd: string;
  workspaceId: string;
  title?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
  checkpoints: SessionCheckpoint[];
  /** Injected once on the next prompt after a conversation rewind. */
  seedContext?: string;
  /** ACP mode ids advertised by `session/new`. */
  availableModeIds: string[];
  /** ACP config options from session/new or config_option_update. */
  configOptions: HelmConfigOption[];
  /** Latest ACP usage_update. */
  usage?: SessionUsage;
  /** In-flight prompt abort via ACP cancel. */
  promptAbort?: AbortController | undefined;
}

/** Map product mode → an advertised ACP mode id, or undefined to leave default. */
export function pickAcpModeId(
  mode: SessionMode,
  available: string[],
  overrides?: { agent?: string; plan?: string; ask?: string },
): string | undefined {
  if (available.length === 0) return undefined;
  const preferred =
    mode === "plan"
      ? overrides?.plan?.trim() || "plan"
      : mode === "ask"
        ? overrides?.ask?.trim() || "ask"
        : overrides?.agent?.trim() || "build";
  if (available.includes(preferred)) return preferred;
  const fallbacks =
    mode === "plan"
      ? ["plan"]
      : mode === "ask"
        ? ["ask"]
        : ["build", "code", "agent"];
  return fallbacks.find((id) => available.includes(id));
}

export interface AgentGatewayHealth {
  ok: boolean;
  provider: string;
  harness: string;
  version?: string;
  managed?: unknown;
  error?: string;
}

export class AgentGateway {
  private readonly sessions = new Map<string, GatewaySessionRecord>();
  private readonly byAcpId = new Map<string, string>();
  private readonly sseListeners = new Set<
    (event: SessionStreamEvent) => void
  >();
  /** Accumulate streaming message text per (session, role) until turn ends. */
  private readonly streamBuffers = new Map<
    string,
    {
      id: string;
      text: string;
      role: TimelineEntry["role"];
      kind: TimelineEntry["kind"];
    }
  >();
  /** Harness-advertised `provider/model` ids from ACP configOptions. */
  private discoveredModels: string[] = [];
  private readonly store: SessionStore;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly getConnection: () => AcpConnection,
    private readonly harness?: HarnessRuntime | null,
    private readonly workspaces?: WorkspaceRegistry,
  ) {
    const dir =
      resolveAgentSettings().sessionsDir?.trim() ||
      defaultSessionsDir(this.config.WORKSPACES_PATH);
    this.store = new SessionStore(
      dir,
      this.logger.child({ component: "session-store" }),
    );
  }

  /** Load durable sessions. ACP ids are rebuilt on the next prompt. */
  async restore(): Promise<void> {
    const loaded = await this.store.loadAll();
    for (const row of loaded) {
      const seed = row.seedContext?.trim() || formatSeedContext(row.timeline);
      const record: GatewaySessionRecord = {
        ...row,
        acpSessionId: "",
        ...(seed ? { seedContext: seed } : {}),
      };
      this.sessions.set(record.helmId, record);
    }
    this.logger.info("restored sessions", {
      count: loaded.length,
      dir:
        resolveAgentSettings().sessionsDir?.trim() ||
        defaultSessionsDir(this.config.WORKSPACES_PATH),
    });
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  /** ACP session/update → timeline + SSE. */
  handleAcpUpdate(params: {
    sessionId: string;
    update: Record<string, unknown>;
  }): void {
    const helmId = this.byAcpId.get(params.sessionId);
    if (!helmId) {
      this.logger.debug("acp update for unknown session", {
        acpSessionId: params.sessionId,
      });
      return;
    }
    const record = this.sessions.get(helmId);
    if (!record) return;

    const mapped = mapAcpSessionUpdate(params, { helmSessionId: helmId });
    if (mapped.status) {
      record.status = mapped.status;
      record.updatedAt = new Date().toISOString();
    }
    if (mapped.usage) {
      record.usage = mapped.usage;
      record.updatedAt = new Date().toISOString();
      this.logger.info("session usage", {
        sessionId: helmId,
        used: mapped.usage.used,
        size: mapped.usage.size,
        cost: mapped.usage.cost,
      });
    }
    if (mapped.configOptions && mapped.configOptions.length > 0) {
      record.configOptions = mapped.configOptions;
      this.rememberDiscoveredModels(mapped.configOptions);
    }

    for (const entry of mapped.timelineUpserts) {
      this.upsertTimelineStreaming(record, entry);
    }
    for (const event of mapped.events) {
      this.emit(event);
    }
    this.persist(record);
  }

  subscribe(listener: (event: SessionStreamEvent) => void): () => void {
    this.sseListeners.add(listener);
    return () => {
      this.sseListeners.delete(listener);
    };
  }

  health(): AgentGatewayHealth {
    const managed = this.harness?.status;
    try {
      const conn = this.getConnection();
      return {
        ok: true,
        provider: "acp",
        harness: this.config.AGENT_HARNESS,
        ...(conn.agentName ? { version: conn.agentName } : {}),
        ...(managed !== undefined ? { managed } : { managed: false }),
      };
    } catch (err) {
      return {
        ok: false,
        provider: "acp",
        harness: this.config.AGENT_HARNESS,
        error: err instanceof Error ? err.message : String(err),
        ...(managed !== undefined ? { managed } : { managed: false }),
      };
    }
  }

  async models(forceRefresh = false): Promise<ModelsCatalog> {
    const discovered = await this.discoverHarnessModels(forceRefresh);
    return loadAgentModelsCatalog(this.config, {
      forceRefresh,
      discoveredModels: discovered,
    });
  }

  async createSession(input?: {
    title?: string;
    workspaceId?: string;
  }): Promise<AgentSession> {
    const cwd = this.resolveSessionCwd(input?.workspaceId);
    const workspaceId = this.resolveWorkspaceId(input?.workspaceId);

    const opened = await this.openAcpSession(cwd);

    const helmId = randomUUID();
    const now = new Date().toISOString();
    const record: GatewaySessionRecord = {
      helmId,
      acpSessionId: opened.acpSessionId,
      cwd,
      workspaceId,
      ...(input?.title !== undefined ? { title: input.title } : {}),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      timeline: [],
      checkpoints: [],
      availableModeIds: opened.availableModeIds,
      configOptions: opened.configOptions,
      usage: { used: 0, size: DEFAULT_CONTEXT_SIZE },
    };
    this.sessions.set(helmId, record);
    this.byAcpId.set(opened.acpSessionId, helmId);
    this.rememberDiscoveredModels(opened.configOptions);

    await this.applyMode(record, "agent");
    this.logger.info("acp session config", {
      sessionId: helmId,
      options: record.configOptions.map((o) => ({
        id: o.id,
        type: o.type,
        category: o.category,
        values: o.type === "select" ? o.values : undefined,
      })),
    });

    this.emit({
      type: "session.created",
      at: now,
      sessionId: helmId,
      data: { acpSessionId: opened.acpSessionId },
    });
    this.persist(record);

    return this.toAgentSession(record);
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => this.toAgentSession(r));
  }

  getSession(helmId: string): AgentSession {
    return this.toAgentSession(this.require(helmId));
  }

  async deleteSession(helmId: string): Promise<void> {
    const record = this.require(helmId);
    await this.closeAcpSession(record.acpSessionId);
    if (record.acpSessionId) this.byAcpId.delete(record.acpSessionId);
    this.sessions.delete(helmId);
    this.clearStreamBuffers(helmId);
    await this.store.remove(helmId);
    this.emit({
      type: "session.deleted",
      at: new Date().toISOString(),
      sessionId: helmId,
    });
  }

  /**
   * Accept prompt asynchronously (HTTP 202). ACP `session/prompt` runs in background;
   * updates stream via notifications → SSE.
   */
  async submitPrompt(
    helmId: string,
    body: PromptRequest,
  ): Promise<PromptAccepted> {
    const record = this.require(helmId);
    const mode: SessionMode = body.mode ?? "agent";
    const model =
      body.model?.trim() || this.config.AGENT_DEFAULT_MODEL || undefined;
    const prompt = body.prompt?.trim() ?? "";
    if (!prompt) {
      throw new AgentRuntimeError("prompt is required", 400);
    }

    await this.ensureAcpSession(record);
    const conn = this.getConnection();
    await this.applyMode(record, mode);
    await this.applyPromptConfig(record, body);

    const now = new Date().toISOString();
    const userId = `user_${randomUUID()}`;
    const snapshot = await captureWorkspaceCheckpoint(record.cwd).catch(
      (err) => {
        this.logger.debug("checkpoint capture skipped", {
          sessionId: helmId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      },
    );
    const checkpoint: SessionCheckpoint = {
      messageId: userId,
      capturedAt: now,
      prompt,
      ...(snapshot?.tree ? { tree: snapshot.tree } : {}),
    };
    record.checkpoints.push(checkpoint);

    const userEntry: TimelineEntry = {
      id: userId,
      at: now,
      kind: "message",
      role: "user",
      text: prompt,
      done: true,
    };
    record.timeline.push(userEntry);
    const previousTitle = record.title;
    this.hydrateTitle(record);
    record.status = "running";
    record.updatedAt = now;
    this.emit({
      type: "session.message",
      at: now,
      sessionId: helmId,
      data: userEntry,
    });
    if (record.title && record.title !== previousTitle) {
      this.emit({
        type: "session.updated",
        at: now,
        sessionId: helmId,
        data: { title: record.title },
      });
    }
    this.emit({
      type: "session.status",
      at: now,
      sessionId: helmId,
      data: { status: "running" },
    });
    this.persist(record);

    const ac = new AbortController();
    record.promptAbort = ac;

    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text: prompt },
    ];
    const seed = record.seedContext?.trim();
    if (seed) {
      content.unshift({ type: "text", text: seed });
      delete record.seedContext;
    }
    if (body.system?.trim()) {
      content.unshift({ type: "text", text: body.system.trim() });
    }
    if (body.contextPaths?.length) {
      for (const p of body.contextPaths) {
        content.push({
          type: "text",
          text: `Context path: ${p}`,
        });
      }
    }

    // Fire-and-forget ACP prompt (blocks until turn completes on agent side).
    void (async () => {
      try {
        const helm: Record<string, unknown> = { mode };
        if (model) helm.model = model;
        const thinkLevel = body.thinkLevel?.trim();
        if (thinkLevel) helm.thinkLevel = thinkLevel;
        if (typeof body.fast === "boolean") helm.fast = body.fast;
        const result = (await conn.request(acp.methods.agent.session.prompt, {
          sessionId: record.acpSessionId,
          prompt: content,
          _meta: { helm },
        })) as { stopReason?: string; usage?: Record<string, unknown> };
        this.applyPromptUsage(record, result);
        this.finalizeTurn(record, mapStopReason(result.stopReason));
        this.emit({
          type: "session.turn.completed",
          at: new Date().toISOString(),
          sessionId: helmId,
          data: { stopReason: result.stopReason },
        });
      } catch (err) {
        if (ac.signal.aborted) {
          this.finalizeTurn(record, "cancelled");
          this.emit({
            type: "session.turn.cancelled",
            at: new Date().toISOString(),
            sessionId: helmId,
          });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn("acp prompt failed", {
          sessionId: helmId,
          error: message,
        });
        record.timeline.push({
          id: `err_${randomUUID()}`,
          at: new Date().toISOString(),
          kind: "error",
          role: "system",
          text: message,
          done: true,
        });
        this.finalizeTurn(record, "failed");
        this.emit({
          type: "session.error",
          at: new Date().toISOString(),
          sessionId: helmId,
          data: { error: message },
        });
      } finally {
        if (record.promptAbort === ac) record.promptAbort = undefined;
      }
    })();

    return {
      sessionId: helmId,
      status: "accepted",
      mode,
      ...(model !== undefined ? { model } : {}),
    };
  }

  history(
    helmId: string,
    limit?: number,
  ): {
    sessionId: string;
    session: AgentSession;
    entries: TimelineEntry[];
    usage?: SessionUsage;
  } {
    const record = this.require(helmId);
    let entries = record.timeline;
    if (limit !== undefined && Number.isFinite(limit) && limit >= 0) {
      entries = entries.slice(-limit);
    }
    return {
      sessionId: helmId,
      session: this.toAgentSession(record),
      entries,
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
    };
  }

  async cancel(helmId: string): Promise<boolean> {
    const record = this.require(helmId);
    record.promptAbort?.abort();
    if (!record.acpSessionId) {
      if (record.status === "running") this.finalizeTurn(record, "cancelled");
      return true;
    }
    try {
      await this.getConnection().notify(acp.methods.agent.session.cancel, {
        sessionId: record.acpSessionId,
      });
    } catch (err) {
      this.logger.debug("acp cancel failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (record.status === "running") {
      this.finalizeTurn(record, "cancelled");
    }
    return true;
  }

  /**
   * Rewind to a user message checkpoint. ACP has no rewind — conversation
   * restore replaces the harness session and seeds the next prompt.
   */
  async rewind(
    helmId: string,
    input: { messageId: string; restore?: unknown },
  ): Promise<RewindResponse> {
    const record = this.require(helmId);
    const restore: RewindRestore = parseRewindRestore(input.restore);
    const plan = planRewind(
      record.timeline,
      record.checkpoints,
      input.messageId,
    );

    if (record.status === "running") {
      await this.cancel(helmId);
    }

    const wantsCode = restore === "both" || restore === "code";
    const wantsConversation = restore === "both" || restore === "conversation";

    if (wantsCode && !plan.checkpoint.tree) {
      if (restore === "code") {
        throw new AgentRuntimeError(
          "no file checkpoint for this message (workspace is not a git repo, or capture failed)",
          409,
        );
      }
    }

    let filesRestored = false;
    if (wantsCode && plan.checkpoint.tree) {
      try {
        await restoreWorkspaceCheckpoint(record.cwd, plan.checkpoint.tree);
        filesRestored = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (restore === "code") {
          throw new AgentRuntimeError(
            `failed to restore files: ${message}`,
            500,
          );
        }
        this.logger.warn("rewind file restore failed", {
          sessionId: helmId,
          error: message,
        });
      }
    }

    if (wantsConversation) {
      record.timeline = plan.kept;
      record.checkpoints = plan.keptCheckpoints;
      const seedContext = formatSeedContext(plan.kept);
      if (seedContext) record.seedContext = seedContext;
      else delete record.seedContext;
      this.clearStreamBuffers(helmId);

      const previousAcpId = record.acpSessionId;
      this.byAcpId.delete(previousAcpId);
      await this.closeAcpSession(previousAcpId);
      const opened = await this.openAcpSession(record.cwd);
      record.acpSessionId = opened.acpSessionId;
      record.availableModeIds = opened.availableModeIds;
      record.configOptions = opened.configOptions;
      record.usage = { used: 0, size: DEFAULT_CONTEXT_SIZE };
      this.rememberDiscoveredModels(opened.configOptions);
      this.byAcpId.set(opened.acpSessionId, helmId);
      await this.applyMode(record, "agent");
    }

    record.status = "idle";
    record.updatedAt = new Date().toISOString();

    this.emit({
      type: "session.rewound",
      at: record.updatedAt,
      sessionId: helmId,
      data: {
        messageId: plan.checkpoint.messageId,
        restore,
        truncated: plan.removed.length,
        filesRestored,
        prompt: plan.checkpoint.prompt,
      },
    });
    this.emit({
      type: "session.status",
      at: record.updatedAt,
      sessionId: helmId,
      data: { status: record.status },
    });
    this.persist(record);

    return {
      sessionId: helmId,
      messageId: plan.checkpoint.messageId,
      restore,
      prompt: plan.checkpoint.prompt,
      session: this.toAgentSession(record),
      truncated: plan.removed.length,
      filesRestored,
      entries: record.timeline,
    };
  }

  private finalizeTurn(
    record: GatewaySessionRecord,
    status: SessionStatus,
  ): void {
    this.flushStreamBuffers(record);
    record.status = status === "completed" ? "idle" : status;
    if (status === "completed") record.status = "idle";
    record.updatedAt = new Date().toISOString();
    this.emit({
      type: "session.status",
      at: record.updatedAt,
      sessionId: record.helmId,
      data: { status: record.status, turnStatus: status },
    });
    this.persist(record);
  }

  private upsertTimelineStreaming(
    record: GatewaySessionRecord,
    entry: TimelineEntry,
  ): void {
    // Stream deltas: coalesce message/reasoning chunks into one timeline row.
    if (
      (entry.kind === "message" || entry.kind === "reasoning") &&
      entry.done === false
    ) {
      const key = `${record.helmId}:${entry.kind}:${entry.role}`;
      let buf = this.streamBuffers.get(key);
      if (!buf) {
        buf = {
          id: entry.id,
          text: entry.text,
          role: entry.role,
          kind: entry.kind,
        };
        this.streamBuffers.set(key, buf);
        const row: TimelineEntry = {
          id: buf.id,
          kind: entry.kind,
          role: entry.role,
          text: buf.text,
          done: false,
        };
        if (entry.at !== undefined) row.at = entry.at;
        if (entry.meta) row.meta = entry.meta;
        record.timeline.push(row);
      } else {
        buf.text += entry.text;
        const existing = record.timeline.find((t) => t.id === buf!.id);
        if (existing) {
          existing.text = buf.text;
          if (entry.at !== undefined) {
            existing.at = entry.at;
          }
          if (entry.meta) {
            existing.meta = { ...existing.meta, ...entry.meta };
          }
        }
      }
      return;
    }

    if (entry.kind === "tool") {
      const idx = record.timeline.findIndex((t) => t.id === entry.id);
      if (idx >= 0) {
        record.timeline[idx] = { ...record.timeline[idx], ...entry };
      } else {
        record.timeline.push(entry);
      }
      return;
    }

    record.timeline.push(entry);
  }

  private flushStreamBuffers(record: GatewaySessionRecord): void {
    const prefix = `${record.helmId}:`;
    for (const [key, buf] of this.streamBuffers) {
      if (!key.startsWith(prefix)) continue;
      const existing = record.timeline.find((t) => t.id === buf.id);
      if (existing) {
        existing.text = buf.text;
        existing.done = true;
      }
      this.streamBuffers.delete(key);
    }
  }

  private clearStreamBuffers(helmId: string): void {
    const prefix = `${helmId}:`;
    for (const key of this.streamBuffers.keys()) {
      if (key.startsWith(prefix)) this.streamBuffers.delete(key);
    }
  }

  private resolveWorkspaceId(id?: string): string {
    if (!this.workspaces) return "default";
    return this.workspaces.get(id).id;
  }

  private resolveSessionCwd(workspaceId?: string): string {
    const overlay = resolveAgentSettings().cwd?.trim();
    if (overlay?.startsWith("/")) return overlay;
    if (this.workspaces) {
      const path = this.workspaces.get(workspaceId).path;
      if (!path.startsWith("/")) {
        throw new AgentRuntimeError(
          `workspace path must be absolute, got: ${path}`,
          500,
        );
      }
      return path;
    }
    const cwd = this.config.MAIN_REPO_PATH.trim();
    if (!cwd.startsWith("/")) {
      throw new AgentRuntimeError(
        `session cwd / MAIN_REPO_PATH must be absolute, got: ${cwd}`,
        500,
      );
    }
    return cwd;
  }

  private async openAcpSession(cwd: string): Promise<{
    acpSessionId: string;
    availableModeIds: string[];
    configOptions: HelmConfigOption[];
  }> {
    const created = await this.getConnection().request(
      acp.methods.agent.session.new,
      { cwd, mcpServers: [] },
    );
    const availableModeIds = (created.modes?.availableModes ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return {
      acpSessionId: created.sessionId,
      availableModeIds,
      configOptions: parseConfigOptions(created.configOptions),
    };
  }

  private persist(record: GatewaySessionRecord): void {
    this.store.schedule(record);
  }

  /** Rebuild ACP after restart / rewind-style seed. */
  private async ensureAcpSession(record: GatewaySessionRecord): Promise<void> {
    if (record.acpSessionId) return;
    const seed =
      record.seedContext?.trim() || formatSeedContext(record.timeline);
    if (seed) record.seedContext = seed;
    const opened = await this.openAcpSession(record.cwd);
    record.acpSessionId = opened.acpSessionId;
    record.availableModeIds = opened.availableModeIds;
    record.configOptions = opened.configOptions;
    this.rememberDiscoveredModels(opened.configOptions);
    this.byAcpId.set(opened.acpSessionId, record.helmId);
    this.persist(record);
  }

  private async closeAcpSession(acpSessionId: string): Promise<void> {
    if (!acpSessionId) return;
    const conn = this.getConnection();
    try {
      await conn.notify(acp.methods.agent.session.cancel, {
        sessionId: acpSessionId,
      });
    } catch {
      /* ignore */
    }
    try {
      await conn.request(acp.methods.agent.session.close, {
        sessionId: acpSessionId,
      });
    } catch {
      try {
        await conn.request(acp.methods.agent.session.delete, {
          sessionId: acpSessionId,
        });
      } catch {
        /* best-effort */
      }
    }
  }

  private async applyMode(
    record: GatewaySessionRecord,
    mode: SessionMode,
  ): Promise<void> {
    const modeId = pickAcpModeId(
      mode,
      record.availableModeIds,
      this.harness?.modes,
    );
    if (!modeId) return;
    try {
      await this.getConnection().request(acp.methods.agent.session.setMode, {
        sessionId: record.acpSessionId,
        modeId,
      });
    } catch (err) {
      this.logger.debug("session setMode skipped", {
        modeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async applyPromptConfig(
    record: GatewaySessionRecord,
    body: PromptRequest,
  ): Promise<void> {
    const payloads: SetConfigPayload[] = [];
    const modelId = body.model?.trim();
    if (modelId) {
      const payload = modelSetConfig(record.configOptions, modelId);
      if (payload) payloads.push(payload);
      else {
        this.logger.info("session model config unmatched", {
          sessionId: record.helmId,
          model: modelId,
          optionIds: record.configOptions.map((o) => o.id),
        });
      }
    }
    const thinkLevel = body.thinkLevel?.trim();
    if (thinkLevel) {
      const payload = thinkLevelSetConfig(record.configOptions, thinkLevel);
      if (payload) payloads.push(payload);
      else {
        this.logger.info("session thinkLevel config unmatched", {
          sessionId: record.helmId,
          thinkLevel,
          optionIds: record.configOptions.map((o) => o.id),
        });
      }
    }
    if (typeof body.fast === "boolean") {
      const payload = fastSetConfig(record.configOptions, body.fast);
      if (payload) payloads.push(payload);
    }
    if (payloads.length === 0) return;
    const conn = this.getConnection();
    for (const payload of payloads) {
      try {
        await conn.request(acp.methods.agent.session.setConfigOption, {
          sessionId: record.acpSessionId,
          ...payload,
        });
      } catch (err) {
        this.logger.debug("session setConfigOption skipped", {
          configId: payload.configId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private applyPromptUsage(
    record: GatewaySessionRecord,
    result: { usage?: Record<string, unknown> },
  ): void {
    if (!result.usage) return;
    const next = usageFromPromptResult({ usage: result.usage }, record.usage);
    if (!next) return;
    const current = record.usage;
    if (current && current.used > 0) return;
    record.usage = next;
    record.updatedAt = new Date().toISOString();
    this.emit({
      type: "session.usage",
      at: record.updatedAt,
      sessionId: record.helmId,
      data: next,
    });
    this.logger.info("session usage from prompt result", {
      sessionId: record.helmId,
      used: next.used,
      size: next.size,
    });
  }

  private rememberDiscoveredModels(options: HelmConfigOption[]): void {
    const ids = modelIdsFromConfigOptions(options);
    if (ids.length === 0) return;
    this.discoveredModels = ids;
  }

  private async discoverHarnessModels(
    forceRefresh: boolean,
  ): Promise<string[]> {
    if (!forceRefresh && this.discoveredModels.length > 0) {
      return this.discoveredModels;
    }
    const fromSessions: string[] = [];
    const seen = new Set<string>();
    for (const record of this.sessions.values()) {
      for (const id of modelIdsFromConfigOptions(record.configOptions)) {
        if (seen.has(id)) continue;
        seen.add(id);
        fromSessions.push(id);
      }
    }
    if (!forceRefresh && fromSessions.length > 0) {
      this.discoveredModels = fromSessions;
      return fromSessions;
    }
    try {
      const opened = await this.openAcpSession(this.resolveSessionCwd());
      const ids = modelIdsFromConfigOptions(opened.configOptions);
      await this.closeAcpSession(opened.acpSessionId);
      if (ids.length > 0) this.discoveredModels = ids;
      this.logger.info("discovered harness models", { count: ids.length });
      return this.discoveredModels;
    } catch (err) {
      this.logger.debug("harness model discovery skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.discoveredModels.length > 0
        ? this.discoveredModels
        : fromSessions;
    }
  }

  private require(helmId: string): GatewaySessionRecord {
    const record = this.sessions.get(helmId);
    if (!record) throw new AgentNotFoundError(helmId);
    return record;
  }

  /** Fill a placeholder title from the first user message. */
  private hydrateTitle(record: GatewaySessionRecord): void {
    const next = maybeTitleFromTimeline(record.title, record.timeline);
    if (next === undefined || next === record.title) return;
    record.title = next;
  }

  private toAgentSession(record: GatewaySessionRecord): AgentSession {
    this.hydrateTitle(record);
    return {
      id: record.helmId,
      ...(record.title !== undefined ? { title: record.title } : {}),
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.acpSessionId ? { backend: record.acpSessionId } : {}),
      workspaceId: record.workspaceId,
      ...(record.availableModeIds.length > 0
        ? { modes: record.availableModeIds }
        : {}),
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
    };
  }

  private emit(event: SessionStreamEvent): void {
    for (const listener of this.sseListeners) {
      try {
        listener(event);
      } catch {
        /* ignore subscriber errors */
      }
    }
  }
}
