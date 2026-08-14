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
  SessionMode,
  SessionStatus,
  SessionStreamEvent,
  TimelineEntry,
} from "../sessions/types.js";
import type { AcpConnection } from "./acp/connection.js";
import {
  AgentCapabilityError,
  AgentNotFoundError,
  AgentRuntimeError,
} from "./errors.js";
import type { HarnessRuntime } from "./harnesses/types.js";
import {
  resolveOpenCodeHarnessSettings,
  type OpenCodeHarnessSettings,
} from "./harnesses/opencode/settings.js";
import { mapAcpSessionUpdate, mapStopReason } from "./map-updates.js";
import { loadAgentModelsCatalog, type ModelsCatalog } from "./models.js";
import { resolveAgentSettings } from "./settings.js";

export interface GatewaySessionRecord {
  helmId: string;
  acpSessionId: string;
  title?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
  /** ACP mode ids advertised by `session/new`. */
  availableModeIds: string[];
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
  private readonly sseListeners = new Set<(event: SessionStreamEvent) => void>();
  /** Accumulate streaming message text per (session, role) until turn ends. */
  private readonly streamBuffers = new Map<
    string,
    { id: string; text: string; role: TimelineEntry["role"]; kind: TimelineEntry["kind"] }
  >();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly getConnection: () => AcpConnection,
    private readonly harness?: HarnessRuntime | null,
    private readonly harnessSettings: OpenCodeHarnessSettings = resolveOpenCodeHarnessSettings(),
  ) {}

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

    for (const entry of mapped.timelineUpserts) {
      this.upsertTimelineStreaming(record, entry);
    }
    for (const event of mapped.events) {
      this.emit(event);
    }
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
    return loadAgentModelsCatalog(this.config, { forceRefresh });
  }

  async createSession(input?: {
    title?: string;
  }): Promise<AgentSession> {
    const conn = this.getConnection();
    const cwd = (
      resolveAgentSettings().cwd?.trim() || this.config.MAIN_REPO_PATH
    ).trim();
    if (!cwd.startsWith("/")) {
      throw new AgentRuntimeError(
        `session cwd / MAIN_REPO_PATH must be absolute, got: ${cwd}`,
        500,
      );
    }

    const created = await conn.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });

    const availableModeIds = (created.modes?.availableModes ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const helmId = randomUUID();
    const now = new Date().toISOString();
    const record: GatewaySessionRecord = {
      helmId,
      acpSessionId: created.sessionId,
      ...(input?.title !== undefined ? { title: input.title } : {}),
      status: "idle",
      createdAt: now,
      updatedAt: now,
      timeline: [],
      availableModeIds,
    };
    this.sessions.set(helmId, record);
    this.byAcpId.set(created.sessionId, helmId);

    await this.applyMode(record, "agent");

    this.emit({
      type: "session.created",
      at: now,
      sessionId: helmId,
      data: { acpSessionId: created.sessionId },
    });

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
    const conn = this.getConnection();
    try {
      await conn.notify(acp.methods.agent.session.cancel, {
        sessionId: record.acpSessionId,
      });
    } catch {
      /* ignore */
    }
    try {
      await conn.request(acp.methods.agent.session.close, {
        sessionId: record.acpSessionId,
      });
    } catch {
      // Some agents only support delete; try that next.
      try {
        await conn.request(acp.methods.agent.session.delete, {
          sessionId: record.acpSessionId,
        });
      } catch {
        /* best-effort */
      }
    }
    this.byAcpId.delete(record.acpSessionId);
    this.sessions.delete(helmId);
    this.clearStreamBuffers(helmId);
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

    const conn = this.getConnection();
    await this.applyMode(record, mode);

    const now = new Date().toISOString();
    const userEntry: TimelineEntry = {
      id: `user_${randomUUID()}`,
      at: now,
      kind: "message",
      role: "user",
      text: prompt,
      done: true,
    };
    record.timeline.push(userEntry);
    record.status = "running";
    record.updatedAt = now;
    this.emit({
      type: "session.message",
      at: now,
      sessionId: helmId,
      data: userEntry,
    });
    this.emit({
      type: "session.status",
      at: now,
      sessionId: helmId,
      data: { status: "running" },
    });

    const ac = new AbortController();
    record.promptAbort = ac;

    const content: Array<{ type: "text"; text: string }> = [
      { type: "text", text: prompt },
    ];
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
        const result = (await conn.request(acp.methods.agent.session.prompt, {
          sessionId: record.acpSessionId,
          prompt: content,
          ...(model
            ? {
                _meta: {
                  helm: { model, mode },
                },
              }
            : {}),
        })) as { stopReason?: string };
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
        this.logger.warn("acp prompt failed", { sessionId: helmId, error: message });
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

  history(helmId: string, limit?: number): {
    sessionId: string;
    session: AgentSession;
    entries: TimelineEntry[];
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
    };
  }

  async abort(helmId: string): Promise<boolean> {
    const record = this.require(helmId);
    record.promptAbort?.abort();
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

  revert(_helmId: string, _messageId: string): never {
    throw new AgentCapabilityError(
      "revert is not available on ACP runtimes yet (git checkpoints planned)",
    );
  }

  unrevert(_helmId: string): never {
    throw new AgentCapabilityError(
      "unrevert is not available on ACP runtimes yet",
    );
  }

  diff(_helmId: string): { sessionId: string; diffs: unknown[] } {
    // Product git diffs come later; keep route stable with empty list.
    return { sessionId: _helmId, diffs: [] };
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

  private async applyMode(
    record: GatewaySessionRecord,
    mode: SessionMode,
  ): Promise<void> {
    const modeId = pickAcpModeId(
      mode,
      record.availableModeIds,
      this.harnessSettings.modes,
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

  private require(helmId: string): GatewaySessionRecord {
    const record = this.sessions.get(helmId);
    if (!record) throw new AgentNotFoundError(helmId);
    return record;
  }

  private toAgentSession(record: GatewaySessionRecord): AgentSession {
    return {
      id: record.helmId,
      ...(record.title !== undefined ? { title: record.title } : {}),
      status: record.status,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      backend: record.acpSessionId,
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
