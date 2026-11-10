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
  mergeSessionUsage,
  usageFromPromptResult,
} from "./map-updates.js";
import {
  contextLevelsFromConfigOptions,
  contextSetConfig,
  currentContextFromConfigOptions,
  fastSetConfig,
  modelEntriesFromConfigOptions,
  modelSetConfig,
  parseConfigOptions,
  parseContextTokens,
  supportsFastFromConfigOptions,
  thinkingLevelsFromConfigOptions,
  thinkingSetConfig,
  thinkLevelsFromConfigOptions,
  thinkLevelSetConfig,
  stripModelDecoration,
  type HelmConfigOption,
  type ModelSelectEntry,
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
  /** Harness-advertised models from ACP configOptions (cleaned ids/names). */
  private discoveredModels: ModelSelectEntry[] = [];
  /** Effort / reasoning levels the harness accepts. */
  private discoveredThinkLevels: string[] = [];
  /** Thinking on/off values when advertised. */
  private discoveredThinkingLevels: string[] = [];
  /** Context window sizes when advertised. */
  private discoveredContextLevels: string[] = [];
  /** Current context selection when known. */
  private discoveredContext: string | undefined;
  /** Whether the harness advertises a fast option. */
  private discoveredSupportsFast = false;
  /**
   * Per-model caps from Cursor `list_available_models`. Effort/fast/context
   * differ by model — never apply another model's empty set over a richer one.
   */
  private cursorModelCaps = new Map<
    string,
    {
      thinkLevels: string[];
      thinkingLevels: string[];
      contextLevels: string[];
      context?: string;
      supportsFast: boolean;
    }
  >();
  /** Last model whose caps are currently published on the catalog. */
  private lastCapabilityModelId: string | undefined;
  /** Serialize catalog probes so concurrent refreshes cannot thrash caps. */
  private modelsRequestTail: Promise<unknown> = Promise.resolve();
  /** Freshness of the last successful `cursor/list_available_models`. */
  private cursorCatalogAt = 0;
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

    const updateKind =
      typeof params.update.sessionUpdate === "string"
        ? params.update.sessionUpdate
        : "unknown";
    // Usage / config are sparse and product-critical — always leave a breadcrumb.
    if (
      updateKind === "usage_update" ||
      updateKind === "config_option_update" ||
      updateKind === "current_mode_update"
    ) {
      this.logger.info("acp session update", {
        sessionId: helmId,
        kind: updateKind,
        keys: Object.keys(params.update),
        update: params.update,
      });
    } else {
      this.logger.debug("acp session update", {
        sessionId: helmId,
        kind: updateKind,
        keys: Object.keys(params.update),
      });
    }

    const mapped = mapAcpSessionUpdate(params, { helmSessionId: helmId });
    if (mapped.status) {
      record.status = mapped.status;
      record.updatedAt = new Date().toISOString();
    }
    if (mapped.usage) {
      record.usage = mergeSessionUsage(record.usage, mapped.usage);
      record.updatedAt = new Date().toISOString();
      this.logger.info("session usage", {
        sessionId: helmId,
        used: record.usage.used,
        size: record.usage.size,
        cost: record.usage.cost,
      });
    } else if (updateKind === "usage_update") {
      this.logger.warn("acp usage_update not mapped", {
        sessionId: helmId,
        update: params.update,
      });
    }
    if (mapped.configOptions && mapped.configOptions.length > 0) {
      record.configOptions = mapped.configOptions;
      this.rememberDiscoveredModels(mapped.configOptions);
      this.syncUsageSizeFromContext(record);
      this.emitCapabilities(helmId);
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

  async models(
    forceRefresh = false,
    probeModel?: string,
  ): Promise<ModelsCatalog> {
    const run = this.modelsRequestTail.then(() =>
      this.modelsUnlocked(forceRefresh, probeModel),
    );
    // Keep the queue alive even when a probe fails.
    this.modelsRequestTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async modelsUnlocked(
    forceRefresh = false,
    probeModel?: string,
  ): Promise<ModelsCatalog> {
    const probe =
      probeModel?.trim() || this.lastCapabilityModelId || undefined;
    if (probe) {
      const fromCursor = await this.discoverCursorParameterizedCatalog(
        probe,
        forceRefresh,
      );
      if (!fromCursor) {
        await this.probeModelCapabilities(probe);
      }
    } else {
      await this.discoverHarnessCapabilities(forceRefresh);
    }
    const catalogOpts: Parameters<typeof loadAgentModelsCatalog>[1] = {
      forceRefresh,
      discoveredModels: this.discoveredModels,
      thinkLevels: this.discoveredThinkLevels,
      thinkingLevels: this.discoveredThinkingLevels,
      contextLevels: this.discoveredContextLevels,
      supportsFast: this.discoveredSupportsFast,
    };
    if (this.discoveredContext) {
      catalogOpts.context = this.discoveredContext;
    }
    return loadAgentModelsCatalog(this.config, catalogOpts);
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
        if (body.thinking !== undefined && body.thinking !== null) {
          helm.thinking = body.thinking;
        }
        const context = body.context?.trim();
        if (context) helm.context = context;
        if (typeof body.fast === "boolean") helm.fast = body.fast;
        const result = (await conn.request(acp.methods.agent.session.prompt, {
          sessionId: record.acpSessionId,
          prompt: content,
          _meta: { helm },
        })) as { stopReason?: string; usage?: Record<string, unknown> } &
          Record<string, unknown>;
        this.logger.info("acp prompt result", {
          sessionId: helmId,
          stopReason: result.stopReason,
          keys: Object.keys(result),
          hasUsage: result.usage != null,
          usage:
            result.usage && typeof result.usage === "object"
              ? result.usage
              : undefined,
        });
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
    // Cursor (and similar) advertise effort/fast/context only after the model
    // is selected — set model first, then the dependent knobs.
    const modelId = body.model?.trim();
    if (modelId) {
      const payload = modelSetConfig(record.configOptions, modelId);
      if (payload) {
        await this.applyConfigPayload(record, payload);
      } else {
        this.logger.info("session model config unmatched", {
          sessionId: record.helmId,
          model: modelId,
          optionIds: record.configOptions.map((o) => o.id),
        });
      }
    }

    const followUps: SetConfigPayload[] = [];
    const thinkLevel = body.thinkLevel?.trim();
    if (thinkLevel) {
      const payload = thinkLevelSetConfig(record.configOptions, thinkLevel);
      if (payload) followUps.push(payload);
      else {
        this.logger.info("session thinkLevel config unmatched", {
          sessionId: record.helmId,
          thinkLevel,
          optionIds: record.configOptions.map((o) => o.id),
        });
      }
    }
    if (
      body.thinking !== undefined &&
      body.thinking !== null &&
      body.thinking !== ""
    ) {
      const payload = thinkingSetConfig(record.configOptions, body.thinking);
      if (payload) followUps.push(payload);
    }
    const context = body.context?.trim();
    if (context) {
      const payload = contextSetConfig(record.configOptions, context);
      if (payload) followUps.push(payload);
      else {
        this.logger.info("session context config unmatched", {
          sessionId: record.helmId,
          context,
          optionIds: record.configOptions.map((o) => o.id),
        });
      }
    }
    if (typeof body.fast === "boolean") {
      const payload = fastSetConfig(record.configOptions, body.fast);
      if (payload) followUps.push(payload);
    }
    for (const payload of followUps) {
      await this.applyConfigPayload(record, payload);
    }
  }

  private async applyConfigPayload(
    record: GatewaySessionRecord,
    payload: SetConfigPayload,
  ): Promise<void> {
    try {
      const result = (await this.getConnection().request(
        acp.methods.agent.session.setConfigOption,
        {
          sessionId: record.acpSessionId,
          ...payload,
        },
      )) as { configOptions?: unknown };
      if (result?.configOptions) {
        const options = parseConfigOptions(result.configOptions);
        if (options.length > 0) {
          record.configOptions = options;
          this.applyDiscoveredCapabilities(options);
          this.syncUsageSizeFromContext(record);
          this.emitCapabilities(record.helmId);
        }
      }
    } catch (err) {
      this.logger.debug("session setConfigOption skipped", {
        configId: payload.configId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private applyPromptUsage(
    record: GatewaySessionRecord,
    result: { usage?: Record<string, unknown> } & Record<string, unknown>,
  ): void {
    // Prefer nested `usage`; also accept top-level token fields from experimental agents.
    const next =
      (result.usage
        ? usageFromPromptResult({ usage: result.usage }, record.usage)
        : undefined) ?? usageFromPromptResult(result, record.usage);
    if (!next) {
      this.logger.info("acp prompt usage missing", {
        sessionId: record.helmId,
        keys: Object.keys(result),
        currentUsed: record.usage?.used ?? 0,
        currentSize: record.usage?.size ?? 0,
      });
      return;
    }
    const merged = mergeSessionUsage(record.usage, next);
    const previous = record.usage;
    if (
      previous &&
      previous.used === merged.used &&
      previous.size === merged.size &&
      JSON.stringify(previous.cost) === JSON.stringify(merged.cost)
    ) {
      return;
    }
    record.usage = merged;
    record.updatedAt = new Date().toISOString();
    this.emit({
      type: "session.usage",
      at: record.updatedAt,
      sessionId: record.helmId,
      data: merged,
    });
    this.logger.info("session usage from prompt result", {
      sessionId: record.helmId,
      used: merged.used,
      size: merged.size,
    });
  }

  private rememberDiscoveredModels(options: HelmConfigOption[]): void {
    this.applyDiscoveredCapabilities(options);
  }

  private capsFromOptions(options: HelmConfigOption[]): {
    thinkLevels: string[];
    thinkingLevels: string[];
    contextLevels: string[];
    context?: string;
    supportsFast: boolean;
  } {
    const context = currentContextFromConfigOptions(options);
    return {
      thinkLevels: thinkLevelsFromConfigOptions(options),
      thinkingLevels: thinkingLevelsFromConfigOptions(options),
      contextLevels: contextLevelsFromConfigOptions(options),
      ...(context ? { context } : {}),
      supportsFast: supportsFastFromConfigOptions(options),
    };
  }

  private capsNonEmpty(caps: {
    thinkLevels: string[];
    thinkingLevels: string[];
    contextLevels: string[];
    supportsFast: boolean;
  }): boolean {
    return (
      caps.thinkLevels.length > 0 ||
      caps.thinkingLevels.length > 0 ||
      caps.contextLevels.length > 0 ||
      caps.supportsFast
    );
  }

  private applyCaps(caps: {
    thinkLevels: string[];
    thinkingLevels: string[];
    contextLevels: string[];
    context?: string;
    supportsFast: boolean;
  }): void {
    this.discoveredThinkLevels = caps.thinkLevels;
    this.discoveredThinkingLevels = caps.thinkingLevels;
    this.discoveredContextLevels = caps.contextLevels;
    this.discoveredContext = caps.context;
    this.discoveredSupportsFast = caps.supportsFast;
  }

  private rememberCursorModelCaps(
    modelId: string,
    options: HelmConfigOption[],
  ): void {
    const id = stripModelDecoration(modelId);
    if (!id) return;
    const next = this.capsFromOptions(options);
    const prev = this.cursorModelCaps.get(id);
    // Keep a richer prior entry when Cursor returns an empty options blob.
    if (prev && this.capsNonEmpty(prev) && !this.capsNonEmpty(next)) return;
    this.cursorModelCaps.set(id, next);
  }

  private publishCapsForModel(modelId: string | undefined): void {
    const id = modelId ? stripModelDecoration(modelId) : "";
    if (id) {
      const caps = this.cursorModelCaps.get(id);
      if (caps) {
        this.applyCaps(caps);
        this.lastCapabilityModelId = id;
        return;
      }
    }
    if (
      this.lastCapabilityModelId &&
      this.cursorModelCaps.has(this.lastCapabilityModelId)
    ) {
      this.applyCaps(this.cursorModelCaps.get(this.lastCapabilityModelId)!);
    }
  }

  private applyDiscoveredCapabilities(options: HelmConfigOption[]): void {
    const entries = modelEntriesFromConfigOptions(options);
    if (entries.length > 0) this.discoveredModels = entries;
    this.applyCaps(this.capsFromOptions(options));
  }

  private hasModelDependentCaps(): boolean {
    return (
      this.discoveredThinkLevels.length > 0 ||
      this.discoveredThinkingLevels.length > 0 ||
      this.discoveredContextLevels.length > 0 ||
      this.discoveredSupportsFast
    );
  }

  private emitCapabilities(sessionId: string): void {
    this.emit({
      type: "session.config",
      at: new Date().toISOString(),
      sessionId,
      data: {
        thinkLevels: this.discoveredThinkLevels,
        thinkingLevels: this.discoveredThinkingLevels,
        contextLevels: this.discoveredContextLevels,
        ...(this.discoveredContext
          ? { context: this.discoveredContext }
          : {}),
        supportsFast: this.discoveredSupportsFast,
      },
    });
  }

  private syncUsageSizeFromContext(record: GatewaySessionRecord): void {
    const label = this.discoveredContext;
    if (!label) return;
    const size = parseContextTokens(label);
    if (size === undefined) return;
    const used = record.usage?.used ?? 0;
    const cost = record.usage?.cost;
    if (record.usage?.size === size) return;
    record.usage = {
      used: Math.min(used, size),
      size,
      ...(cost ? { cost } : {}),
    };
    record.updatedAt = new Date().toISOString();
    this.emit({
      type: "session.usage",
      at: record.updatedAt,
      sessionId: record.helmId,
      data: record.usage,
    });
  }

  /**
   * Select a model so Cursor-style harnesses advertise effort/fast/context for
   * that model, then cache the resulting capability lists.
   */
  private async probeModelCapabilities(modelId: string): Promise<void> {
    const id = stripModelDecoration(modelId);
    // Prefer cached Cursor caps — avoids session/setConfigOption thrash.
    if (id && this.cursorModelCaps.has(id)) {
      this.publishCapsForModel(id);
      return;
    }

    for (const record of this.sessions.values()) {
      if (record.configOptions.length === 0 || !record.acpSessionId) continue;
      const payload = modelSetConfig(record.configOptions, modelId);
      if (!payload) continue;
      await this.applyConfigPayload(record, payload);
      this.rememberCursorModelCaps(id || modelId, record.configOptions);
      this.publishCapsForModel(id || modelId);
      if (this.discoveredModels.length === 0) {
        this.applyDiscoveredCapabilities(record.configOptions);
      }
      return;
    }

    try {
      const opened = await this.openAcpSession(this.resolveSessionCwd());
      this.applyDiscoveredCapabilities(opened.configOptions);
      const payload = modelSetConfig(opened.configOptions, modelId);
      if (payload) {
        const result = (await this.getConnection().request(
          acp.methods.agent.session.setConfigOption,
          {
            sessionId: opened.acpSessionId,
            ...payload,
          },
        )) as { configOptions?: unknown };
        const options = parseConfigOptions(result?.configOptions);
        if (options.length > 0) {
          this.rememberCursorModelCaps(id || modelId, options);
          this.publishCapsForModel(id || modelId);
          // Preserve model list if already discovered.
          if (this.discoveredModels.length === 0) {
            this.applyDiscoveredCapabilities(options);
          }
        }
      }
      await this.closeAcpSession(opened.acpSessionId);
      this.logger.info("probed model capabilities", {
        model: modelId,
        thinkLevels: this.discoveredThinkLevels.length,
        thinkingLevels: this.discoveredThinkingLevels.length,
        contextLevels: this.discoveredContextLevels.length,
        supportsFast: this.discoveredSupportsFast,
      });
    } catch (err) {
      this.logger.debug("model capability probe skipped", {
        model: modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Cursor extension: bare model ids + per-model configOptions.
   * Prefer this over compound `model[fast=true]` session/new lists.
   */
  private async discoverCursorParameterizedCatalog(
    probeModel?: string,
    forceRefresh = false,
  ): Promise<boolean> {
    const probeId = stripModelDecoration(probeModel ?? "") || undefined;
    const cacheFresh =
      !forceRefresh &&
      this.discoveredModels.length > 0 &&
      this.cursorModelCaps.size > 0 &&
      Date.now() - this.cursorCatalogAt < 30_000;
    if (cacheFresh) {
      this.publishCapsForModel(probeId ?? this.lastCapabilityModelId);
      return true;
    }

    try {
      const result = (await this.getConnection().request(
        "cursor/list_available_models",
        { _meta: { parameterizedModelPicker: true } },
      )) as {
        models?: Array<{
          value?: string;
          name?: string;
          configOptions?: unknown;
        }>;
      };
      const rows = Array.isArray(result?.models) ? result.models : [];
      if (rows.length === 0) return false;

      const entries: ModelSelectEntry[] = [];
      for (const row of rows) {
        const id = stripModelDecoration(String(row.value ?? "").trim());
        if (!id) continue;
        const name = stripModelDecoration(String(row.name ?? id).trim()) || id;
        entries.push({
          id,
          wireValue: id,
          name,
          capabilityKeys: [],
        });
        this.rememberCursorModelCaps(id, parseConfigOptions(row.configOptions));
      }
      if (entries.length === 0) return false;

      this.discoveredModels = entries;
      this.cursorCatalogAt = Date.now();
      const fallbackId =
        this.lastCapabilityModelId &&
        entries.some((e) => e.id === this.lastCapabilityModelId)
          ? this.lastCapabilityModelId
          : entries.find((e) => {
              const caps = this.cursorModelCaps.get(e.id);
              return caps ? this.capsNonEmpty(caps) : false;
            })?.id ||
            entries.find((e) => e.id !== "default")?.id ||
            entries[0]?.id;
      this.publishCapsForModel(probeId ?? fallbackId);
      this.logger.info("cursor parameterized catalog", {
        models: entries.length,
        probe: probeId ?? fallbackId ?? "-",
        thinkLevels: this.discoveredThinkLevels.length,
        thinkingLevels: this.discoveredThinkingLevels.length,
        contextLevels: this.discoveredContextLevels.length,
        supportsFast: this.discoveredSupportsFast,
      });
      return true;
    } catch (err) {
      this.logger.debug("cursor/list_available_models unavailable", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async discoverHarnessCapabilities(
    forceRefresh: boolean,
  ): Promise<void> {
    if (
      !forceRefresh &&
      (this.discoveredModels.length > 0 || this.hasModelDependentCaps())
    ) {
      return;
    }

    if (await this.discoverCursorParameterizedCatalog(undefined, forceRefresh)) {
      return;
    }

    for (const record of this.sessions.values()) {
      if (record.configOptions.length === 0) continue;
      this.applyDiscoveredCapabilities(record.configOptions);
      if (
        this.discoveredModels.length > 0 &&
        (this.hasModelDependentCaps() || !forceRefresh)
      ) {
        if (!this.hasModelDependentCaps() && this.discoveredModels[0]) {
          await this.probeModelCapabilities(this.discoveredModels[0].id);
        }
        return;
      }
    }

    try {
      const opened = await this.openAcpSession(this.resolveSessionCwd());
      this.applyDiscoveredCapabilities(opened.configOptions);
      if (!this.hasModelDependentCaps() && this.discoveredModels[0]) {
        const payload = modelSetConfig(
          opened.configOptions,
          this.discoveredModels[0].id,
        );
        if (payload) {
          const result = (await this.getConnection().request(
            acp.methods.agent.session.setConfigOption,
            {
              sessionId: opened.acpSessionId,
              ...payload,
            },
          )) as { configOptions?: unknown };
          const options = parseConfigOptions(result?.configOptions);
          if (options.length > 0) {
            this.applyDiscoveredCapabilities(options);
          }
        }
      }
      await this.closeAcpSession(opened.acpSessionId);
      this.logger.info("discovered harness capabilities", {
        models: this.discoveredModels.length,
        thinkLevels: this.discoveredThinkLevels.length,
        thinkingLevels: this.discoveredThinkingLevels.length,
        contextLevels: this.discoveredContextLevels.length,
        supportsFast: this.discoveredSupportsFast,
      });
    } catch (err) {
      this.logger.debug("harness capability discovery skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
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
