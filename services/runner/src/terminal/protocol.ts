/**
 * WebSSH control-plane messages (text WebSocket frames).
 * Binary frames carry raw PTY stdin/stdout bytes.
 */

export type TerminalClientMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping"; t?: number }
  | { type: "stdin"; data: string }; // optional JSON stdin (prefer binary)

export type TerminalServerMessage =
  | {
      type: "ready";
      sessionId: string;
      backend: "local-pty";
      shell: string;
      cwd: string;
    }
  | { type: "pong"; t?: number }
  | { type: "error"; message: string }
  | { type: "exit"; status?: number; signal?: number };

export function parseClientMessage(raw: string): TerminalClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (type === "resize") {
    const cols = Number(obj.cols);
    const rows = Number(obj.rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    if (cols < 1 || rows < 1 || cols > 500 || rows > 200) return null;
    return { type: "resize", cols: Math.floor(cols), rows: Math.floor(rows) };
  }
  if (type === "ping") {
    return {
      type: "ping",
      ...(typeof obj.t === "number" ? { t: obj.t } : {}),
    };
  }
  if (type === "stdin" && typeof obj.data === "string") {
    return { type: "stdin", data: obj.data };
  }
  return null;
}

export function encodeServerMessage(msg: TerminalServerMessage): string {
  return JSON.stringify(msg);
}
