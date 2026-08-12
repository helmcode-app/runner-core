/**
 * Thin HTTP client for a local `opencode serve` daemon.
 *
 * Upstream (default base http://127.0.0.1:4096) — see https://opencode.ai/docs/server/
 *
 * Sessions:  POST/GET/DELETE /session[/:id]
 * Messages:  GET/POST /session/:id/message · POST …/prompt_async
 * Control:   POST …/abort · …/revert · …/unrevert · GET …/diff
 * Meta:      GET /global/health · /provider · SSE /global/event
 */

import type { Logger } from "../logger.js";
import { OpenCodeUpstreamError } from "./types.js";
import {
  OpenCodeTransport,
  enc,
  withSignal,
  type TransportRequestOpts,
} from "./transport.js";

export interface OpenCodeClientOptions {
  /** Base URL of opencode serve (no trailing slash). */
  baseUrl: string;
  /** Optional Basic auth when OPENCODE_SERVER_PASSWORD is set on the daemon. */
  basicAuth?: { username: string; password: string };
  /** Request timeout for non-SSE calls (ms). */
  timeoutMs?: number;
  logger?: Logger;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly transport: OpenCodeTransport;

  constructor(opts: OpenCodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.transport = new OpenCodeTransport({
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      ...(opts.basicAuth !== undefined ? { basicAuth: opts.basicAuth } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
  }

  private requestJson<T = unknown>(
    method: string,
    path: string,
    opts: TransportRequestOpts = {},
  ): Promise<T> {
    return this.transport.requestJson(method, path, opts);
  }

  private request(
    method: string,
    path: string,
    opts: TransportRequestOpts = {},
  ): Promise<Response> {
    return this.transport.request(method, path, opts);
  }

  // ── Health ─────────────────────────────────────────────────

  /** GET /global/health */
  async health(signal?: AbortSignal): Promise<{
    healthy: boolean;
    version?: string;
  }> {
    const data = await this.requestJson<{ healthy?: boolean; version?: string }>(
      "GET",
      "/global/health",
      withSignal({}, signal),
    );
    return {
      healthy: data.healthy === true,
      ...(data.version !== undefined ? { version: data.version } : {}),
    };
  }

  /**
   * GET /provider — installed providers + models; `connected` lists authed providers.
   */
  async listProviders(signal?: AbortSignal): Promise<unknown> {
    return this.requestJson("GET", "/provider", withSignal({}, signal));
  }

  // ── Sessions ───────────────────────────────────────────────

  async createSession(
    body: { title?: string; parentID?: string } = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestJson("POST", "/session", withSignal({ body }, signal));
  }

  async listSessions(signal?: AbortSignal): Promise<unknown> {
    return this.requestJson("GET", "/session", withSignal({}, signal));
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/session/${enc(sessionId)}`,
      withSignal({}, signal),
    );
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/session/${enc(sessionId)}`,
      withSignal({}, signal),
    );
  }

  async abortSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/session/${enc(sessionId)}/abort`,
      withSignal({}, signal),
    );
  }

  /**
   * POST /session/:id/revert — undo effects of a message (and later ones).
   */
  async revertSession(
    sessionId: string,
    body: { messageID: string; partID?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/session/${enc(sessionId)}/revert`,
      withSignal({ body }, signal),
    );
  }

  async unrevertSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/session/${enc(sessionId)}/unrevert`,
      withSignal({}, signal),
    );
  }

  async sessionDiff(
    sessionId: string,
    opts: { messageID?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const q =
      opts.messageID !== undefined
        ? `?messageID=${encodeURIComponent(opts.messageID)}`
        : "";
    return this.requestJson(
      "GET",
      `/session/${enc(sessionId)}/diff${q}`,
      withSignal({}, opts.signal),
    );
  }

  // ── Messages ───────────────────────────────────────────────

  async listMessages(
    sessionId: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const q =
      opts.limit !== undefined
        ? `?limit=${encodeURIComponent(String(opts.limit))}`
        : "";
    return this.requestJson(
      "GET",
      `/session/${enc(sessionId)}/message${q}`,
      withSignal({}, opts.signal),
    );
  }

  /**
   * POST /session/:id/prompt_async — fire-and-forget (204).
   */
  async promptAsync(
    sessionId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "POST",
      `/session/${enc(sessionId)}/prompt_async`,
      withSignal({ body, expectNoContent: true }, signal),
    );
  }

  /**
   * POST /session/:id/message — synchronous (prefer promptAsync for iPad).
   */
  async promptSync(
    sessionId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/session/${enc(sessionId)}/message`,
      withSignal(
        { body, timeoutMs: Math.max(this.timeoutMs, 600_000) },
        signal,
      ),
    );
  }

  // ── SSE ────────────────────────────────────────────────────

  /**
   * Open GET /global/event (SSE). Falls back to GET /event on 404.
   */
  async openEventStream(signal?: AbortSignal): Promise<Response> {
    const paths = ["/global/event", "/event"];
    let lastErr: unknown;
    for (const path of paths) {
      try {
        const res = await this.request(
          "GET",
          path,
          withSignal(
            { accept: "text/event-stream", timeoutMs: 0 },
            signal,
          ),
        );
        if (res.status === 404) {
          lastErr = new OpenCodeUpstreamError(`SSE path ${path} not found`, 404);
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new OpenCodeUpstreamError(
            `OpenCode SSE failed: HTTP ${res.status}`,
            res.status,
            text,
          );
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (err instanceof OpenCodeUpstreamError && err.status === 404) {
          continue;
        }
        // Connection errors: fail fast (do not try alternate path).
        if (
          err instanceof OpenCodeUpstreamError &&
          err.status === 502 &&
          err.message.includes("unreachable")
        ) {
          throw err;
        }
        // Network failures rethrown from transport as OpenCodeUpstreamError 502.
        if (err instanceof OpenCodeUpstreamError) throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new OpenCodeUpstreamError("OpenCode SSE unavailable", 502);
  }
}
