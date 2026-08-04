import type { WebSocket } from "ws";
import type { Logger } from "../logger.js";
import type { LocalPty } from "./local-pty.js";
import {
  encodeServerMessage,
  parseClientMessage,
  type TerminalServerMessage,
} from "./protocol.js";

export interface TerminalSessionOptions {
  ws: WebSocket;
  pty: LocalPty;
  log: Logger;
  /** App-level heartbeat interval (ms). 0 disables. Default 25s. */
  heartbeatMs?: number;
  onClose?: () => void;
}

/**
 * Bridge one WebSocket client ↔ one in-process PTY.
 *
 * Framing:
 * - Binary WS frames  ↔  raw PTY bytes
 * - Text JSON         →  control (resize, ping); server may send ready/error/exit/pong
 * - WebSocket protocol ping/pong for proxy keepalive
 */
export class TerminalSession {
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TerminalSessionOptions) {
    this.bind();
  }

  private bind(): void {
    const { ws, pty, log } = this.opts;

    this.sendJson({
      type: "ready",
      sessionId: pty.sessionId,
      backend: "local-pty",
      shell: pty.shell,
      cwd: pty.cwd,
    });

    pty.onData((data) => {
      if (this.closed || ws.readyState !== ws.OPEN) return;
      try {
        // node-pty delivers UTF-8 strings; send as binary for xterm attach compat.
        ws.send(Buffer.from(data, "utf8"), { binary: true });
      } catch (err) {
        log.warn("terminal ws send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      this.sendJson({
        type: "exit",
        status: exitCode,
        ...(signal !== undefined ? { signal } : {}),
      });
      this.close("pty exit");
    });

    ws.on("message", (data, isBinary) => {
      void this.onWsMessage(data, isBinary);
    });

    ws.on("close", () => this.close("ws close"));
    ws.on("error", (err) => {
      log.warn("terminal ws error", { error: err.message });
      this.close("ws error");
    });

    ws.on("pong", () => {
      /* peer alive */
    });

    const hb = this.opts.heartbeatMs ?? 25_000;
    if (hb > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (this.closed || ws.readyState !== ws.OPEN) return;
        try {
          ws.ping();
          this.sendJson({ type: "pong", t: Date.now() });
        } catch {
          this.close("heartbeat failed");
        }
      }, hb);
      this.heartbeatTimer.unref?.();
    }
  }

  private async onWsMessage(
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (this.closed) return;
    const { pty } = this.opts;

    // IMPORTANT: node `ws` often delivers *text* frames as Buffer with isBinary=false.
    // Only treat the frame as raw PTY stdin when the opcode is binary.
    if (isBinary) {
      const buf = toBuffer(data);
      if (buf.length === 0) return;
      // Defensive: some clients mis-send JSON control as binary.
      if (looksLikeJsonObject(buf)) {
        const text = buf.toString("utf8");
        if (this.handleControlText(text)) return;
      }
      pty.write(buf);
      return;
    }

    const text =
      typeof data === "string" ? data : toBuffer(data).toString("utf8");
    // Treat non-JSON text as raw keystrokes (paste fallback).
    if (!text.startsWith("{")) {
      pty.write(text);
      return;
    }

    this.handleControlText(text);
  }

  /** @returns true if `text` was a recognized control message. */
  private handleControlText(text: string): boolean {
    const { pty } = this.opts;
    const msg = parseClientMessage(text);
    if (!msg) return false;

    if (msg.type === "ping") {
      this.sendJson({
        type: "pong",
        ...(msg.t !== undefined ? { t: msg.t } : {}),
      });
      return true;
    }

    if (msg.type === "stdin") {
      pty.write(msg.data);
      return true;
    }

    if (msg.type === "resize") {
      try {
        pty.resize(msg.cols, msg.rows);
        this.opts.log.info("terminal resized", {
          cols: msg.cols,
          rows: msg.rows,
        });
      } catch (err) {
        this.opts.log.warn("terminal resize failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.sendJson({
          type: "error",
          message: err instanceof Error ? err.message : "resize failed",
        });
      }
      return true;
    }

    return false;
  }

  private sendJson(msg: TerminalServerMessage): void {
    const { ws } = this.opts;
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(encodeServerMessage(msg));
    } catch {
      /* ignore */
    }
  }

  close(reason = "close"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.opts.log.info("terminal session closed", {
      reason,
      sessionId: this.opts.pty.sessionId,
    });
    try {
      this.opts.pty.kill();
    } catch {
      /* ignore */
    }
    const { ws } = this.opts;
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        ws.close(1000, reason.slice(0, 120));
      } catch {
        /* ignore */
      }
    }
    this.opts.onClose?.();
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(String(data));
}

/** True when buffer looks like a UTF-8 JSON object (control plane). */
function looksLikeJsonObject(buf: Buffer): boolean {
  let i = 0;
  while (
    i < buf.length &&
    (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)
  ) {
    i += 1;
  }
  return i < buf.length && buf[i] === 0x7b; // '{'
}
