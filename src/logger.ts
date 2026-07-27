import type { AppConfig } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

class JsonLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger(this.level, { ...this.bindings, ...bindings });
  }

  private emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(extra ?? {}),
    });
    if (level === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.emit("debug", msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>): void {
    this.emit("info", msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    this.emit("warn", msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    this.emit("error", msg, extra);
  }
}

export function createLogger(config: Pick<AppConfig, "LOG_LEVEL" | "mode" | "version">): Logger {
  return new JsonLogger(config.LOG_LEVEL, {
    service: "runner-core",
    mode: config.mode,
    version: config.version,
  });
}
