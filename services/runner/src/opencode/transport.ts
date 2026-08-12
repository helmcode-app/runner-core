/**
 * Low-level HTTP transport for OpenCode Server.
 * Session/message API methods live on OpenCodeClient.
 */

import type { Logger } from "../logger.js";
import { OpenCodeUpstreamError } from "./types.js";

export type TransportRequestOpts = {
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  accept?: string;
  expectNoContent?: boolean;
};

export interface OpenCodeTransportOptions {
  baseUrl: string;
  timeoutMs?: number;
  basicAuth?: { username: string; password: string };
  logger?: Logger;
}

export class OpenCodeTransport {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authHeader: string | undefined;
  private readonly log: Logger | undefined;

  constructor(opts: OpenCodeTransportOptions) {
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

  async requestJson<T = unknown>(
    method: string,
    path: string,
    opts: TransportRequestOpts = {},
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

  async request(
    method: string,
    path: string,
    opts: TransportRequestOpts = {},
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

export function withSignal(
  base: TransportRequestOpts,
  signal?: AbortSignal,
): TransportRequestOpts {
  if (!signal) return base;
  return { ...base, signal };
}

export function enc(id: string): string {
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
