import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { Logger } from "../logger.js";
import {
  JsonRpcCode,
  VfsMethod,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type VfsDidChangeParams,
  type VfsInitializeResult,
  type VfsReadResult,
  type VfsWriteResult,
} from "./protocol.js";
import { resolveHelmVfsBinary } from "./resolveBinary.js";

export interface VfsBridgeOptions {
  /** Absolute path to helm-vfs binary. Default: resolve from env / repo. */
  binaryPath?: string;
  /** Workspace root passed as --root. */
  root: string;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  /** Request timeout in ms (default 120s). 0 disables. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export type VfsBridgeEvents = {
  didChange: [VfsDidChangeParams];
  notification: [{ method: string; params: unknown }];
  error: [Error];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
};

/**
 * Spawns Go `helm-vfs` and multiplexes newline-delimited JSON-RPC over stdio.
 * Emits `didChange` for outbound vfs/didChange notifications.
 */
export class VfsBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string | number, Pending>();
  private nextId = 1;
  private readonly log: Logger;
  private readonly root: string;
  private readonly binaryPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private started = false;

  constructor(opts: VfsBridgeOptions) {
    super();
    this.log = opts.logger.child({ component: "vfs-bridge" });
    this.root = opts.root;
    this.binaryPath = opts.binaryPath ?? resolveHelmVfsBinary();
    this.env = opts.env ?? process.env;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
  }

  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.log.info("spawning helm-vfs", {
      binary: this.binaryPath,
      root: this.root,
    });

    const child = spawn(this.binaryPath, ["--root", this.root], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...this.env, VFS_ROOT: this.root },
    });
    this.child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const text = line.trim();
        if (!text) continue;
        if (text.includes("didChange") || text.includes("watcher")) {
          this.log.info(text);
        } else {
          this.log.debug(text);
        }
      }
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onStdoutLine(line));

    child.on("error", (err) => {
      this.log.error("helm-vfs spawn error", { error: err.message });
      this.failAll(err);
      this.emit("error", err);
    });

    child.on("close", (code, signal) => {
      this.log.info("helm-vfs exited", { code, signal });
      this.child = null;
      this.failAll(
        new Error(`helm-vfs exited (code=${code}, signal=${signal})`),
      );
      this.emit("exit", { code, signal });
    });

    await this.initialize(this.root);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request(VfsMethod.Shutdown, {});
    } catch {
      // ignore
    }
    this.child.kill("SIGTERM");
    this.child = null;
    this.started = false;
  }

  async initialize(root?: string): Promise<VfsInitializeResult> {
    return this.request<VfsInitializeResult>(VfsMethod.Initialize, {
      ...(root !== undefined ? { root } : {}),
    });
  }

  async read(filePath: string): Promise<VfsReadResult> {
    return this.request<VfsReadResult>(VfsMethod.Read, { path: filePath });
  }

  async write(filePath: string, content: string): Promise<VfsWriteResult> {
    return this.request<VfsWriteResult>(VfsMethod.Write, {
      path: filePath,
      content,
    });
  }

  /**
   * Forward a raw JSON-RPC request (from WebSocket / HTTP clients).
   * Notifications without id are written without awaiting a response.
   */
  async forward(message: unknown): Promise<unknown | null> {
    if (!message || typeof message !== "object") {
      throw new Error("invalid JSON-RPC message");
    }
    const msg = message as JsonRpcRequest;
    if (!msg.method || typeof msg.method !== "string") {
      throw new Error("JSON-RPC method is required");
    }
    if (msg.id === undefined || msg.id === null) {
      this.writeLine({
        jsonrpc: "2.0",
        method: msg.method,
        ...(msg.params !== undefined ? { params: msg.params } : {}),
      });
      return null;
    }
    return this.request(msg.method, msg.params ?? {}, msg.id);
  }

  private request<T = unknown>(
    method: string,
    params: unknown,
    id?: string | number,
  ): Promise<T> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("helm-vfs is not running"));
    }
    const reqId = id ?? this.nextId++;
    const payload = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        resolve: (v) => resolve(v as T),
        reject,
      };
      if (this.requestTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.has(reqId)) return;
          this.pending.delete(reqId);
          reject(
            new Error(
              `VFS RPC timeout after ${this.requestTimeoutMs}ms: ${method}`,
            ),
          );
        }, this.requestTimeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(reqId, pending);
      try {
        this.writeLine(payload);
      } catch (err) {
        this.clearPending(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private writeLine(obj: unknown): void {
    if (!this.child?.stdin.writable) {
      throw new Error("helm-vfs stdin is not writable");
    }
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  private onStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      this.log.warn("non-JSON stdout from helm-vfs", {
        line: trimmed.slice(0, 200),
      });
      return;
    }

    if (msg.method && (msg.id === undefined || msg.id === null)) {
      if (msg.method === VfsMethod.DidChange) {
        const params = msg.params as VfsDidChangeParams;
        this.log.info("helm-vfs didChange", {
          path: params?.path,
          type: params?.type,
        });
        this.emit("didChange", params);
      } else {
        this.emit("notification", {
          method: msg.method,
          params: msg.params,
        });
      }
      return;
    }

    if (msg.id === undefined || msg.id === null) return;
    const pending = this.pending.get(msg.id);
    if (!pending) {
      this.log.debug("orphan response", { id: msg.id });
      return;
    }
    this.clearPending(msg.id);
    if (msg.error) {
      pending.reject(
        new Error(
          `VFS RPC ${msg.error.code ?? JsonRpcCode.ServerError}: ${msg.error.message}`,
        ),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private clearPending(id: string | number): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private failAll(err: Error): void {
    for (const [id] of this.pending) {
      const p = this.pending.get(id);
      if (p?.timer) clearTimeout(p.timer);
      p?.reject(err);
    }
    this.pending.clear();
  }
}

export { resolveHelmVfsBinary } from "./resolveBinary.js";
