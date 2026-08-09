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

export interface OpenCodeClientOptions {
  /** Base URL of opencode serve (no trailing slash). */
  baseUrl: string;
  /** Optional Basic auth when OPENCODE_SERVER_PASSWORD is set on the daemon. */
  basicAuth?: { username: string; password: string };
  /** Request timeout for non-SSE calls (ms). */
  timeoutMs?: number;
  logger?: Logger;
}

type RequestOpts = {
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  accept?: string;
  expectNoContent?: boolean;
};

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authHeader: string | undefined;
  private readonly log: Logger | undefined;

  constructor(opts: OpenCodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.logger;
    if (opts.basicAuth?.password) {
      const user = opts.basicAuth.username || "opencode";
      const token = Buffer.from(
        `${user}:${opts.basicAuth.password}`,
        "utf8",
      ).toString("base64");
      this.authHeader = `Basic ${token}`;
    }
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
   * @see https://opencode.ai/docs/server/
   */
  async listProviders(signal?: AbortSignal): Promise<unknown> {
    return this.requestJson("GET", "/provider", withSignal({}, signal));
  }

  // ── Sessions ───────────────────────────────────────────────

  /** POST /session  body: { parentID?, title? } */
  async createSession(
    body: { title?: string; parentID?: string } = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.requestJson("POST", "/session", withSignal({ body }, signal));
  }

  /** GET /session */
  async listSessions(signal?: AbortSignal): Promise<unknown> {
    return this.requestJson("GET", "/session", withSignal({}, signal));
  }

  /** GET /session/:id */
  async getSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestJson(
      "GET",
      `/session/${enc(sessionId)}`,
      withSignal({}, signal),
    );
  }

  /** DELETE /session/:id */
  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestJson(
      "DELETE",
      `/session/${enc(sessionId)}`,
      withSignal({}, signal),
    );
  }

  /** POST /session/:id/abort — cancel in-flight LLM work */
  async abortSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    return this.requestJson(
      "POST",
      `/session/${enc(sessionId)}/abort`,
      withSignal({}, signal),
    );
  }

  /**
   * POST /session/:id/revert — undo effects of a message (and later ones).
   * Body: `{ messageID: "msg_…" }`
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

  /** POST /session/:id/unrevert — restore previously reverted messages. */
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

  /**
   * GET /session/:id/diff?messageID=
   * File changes produced for a user message (optional filter).
   */
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

  /**
   * GET /session/:id/message?limit=
   * Full history for offline rebuild on the iPad.
   */
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
   * POST /session/:id/prompt_async
   * Fire-and-forget: OpenCode keeps running if the iPad disconnects.
   * Upstream returns 204 No Content on success.
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
   * POST /session/:id/message — synchronous (waits for agent turn).
   * Prefer promptAsync for offline-capable iPad flows.
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
   * Caller must cancel `signal` / destroy the body to clean up.
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
        if (isConnectionError(err)) throw err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new OpenCodeUpstreamError("OpenCode SSE unavailable", 502);
  }

  // ── HTTP core ──────────────────────────────────────────────

  private async requestJson<T = unknown>(
    method: string,
    path: string,
    opts: RequestOpts = {},
  ): Promise<T> {
    const res = await this.request(method, path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : text;
      } catch {
        /* keep text */
      }
      throw new OpenCodeUpstreamError(
        `OpenCode ${method} ${path} → HTTP ${res.status}`,
        res.status,
        parsed,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private async request(
    method: string,
    path: string,
    opts: RequestOpts = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Accept: opts.accept ?? "application/json",
    };
    if (this.authHeader) headers.Authorization = this.authHeader;

    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const timeoutMs =
      opts.timeoutMs !== undefined ? opts.timeoutMs : this.timeoutMs;
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort(opts.signal?.reason);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    init.signal = controller.signal;

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        controller.abort(
          new Error(`OpenCode request timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      timer.unref?.();
    }

    this.log?.debug("opencode request", { method, path });

    try {
      const res = await fetch(url, init);

      if (
        opts.expectNoContent &&
        res.ok &&
        (res.status === 204 || res.status === 200)
      ) {
        return res;
      }
      if (opts.expectNoContent && !res.ok) {
        const text = await res.text().catch(() => "");
        throw new OpenCodeUpstreamError(
          `OpenCode ${method} ${path} → HTTP ${res.status}`,
          res.status,
          text,
        );
      }
      return res;
    } catch (err) {
      if (err instanceof OpenCodeUpstreamError) throw err;
      if (isConnectionError(err)) {
        throw new OpenCodeUpstreamError(
          `OpenCode unreachable at ${this.baseUrl} (${errMessage(err)}). Is \`opencode serve\` running?`,
          502,
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

function withSignal(base: RequestOpts, signal?: AbortSignal): RequestOpts {
  if (!signal) return base;
  return { ...base, signal };
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const cause = err as {
    cause?: { code?: string };
    code?: string;
    message?: string;
  };
  const code = cause.cause?.code ?? cause.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  ) {
    return true;
  }
  const msg = errMessage(err).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("network")
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
