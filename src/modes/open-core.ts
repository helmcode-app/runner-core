import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { AgentPipeline } from "../core/agent.js";
import type { Logger } from "../logger.js";
import type {
  AgentResult,
  HealthStatus,
  OpenCoreSubmitBody,
  TaskProgressEvent,
} from "../types.js";

interface TaskRecord {
  result?: AgentResult;
  events: TaskProgressEvent[];
  promise: Promise<AgentResult>;
}

export interface OpenCoreServer {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  agent: AgentPipeline;
  close(): Promise<void>;
}

/**
 * Standalone monolithic API for the iPad / local client (HELM_MODE=open-core).
 * Listens on PORT (default 8080; 0 = ephemeral). No commercial billing/routing.
 */
export async function startOpenCore(
  config: AppConfig,
  logger: Logger,
  opts: { installSignalHandlers?: boolean } = {},
): Promise<OpenCoreServer> {
  const log = logger.child({ component: "open-core" });
  const tasks = new Map<string, TaskRecord>();
  const installSignals = opts.installSignalHandlers !== false;

  const agent = new AgentPipeline({
    config,
    logger,
    onProgress: (event) => {
      const rec = tasks.get(event.taskId);
      if (rec) rec.events.push(event);
    },
  });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      log.error("unhandled request error", {
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "internal error",
      });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = (req.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname === "/health") {
      const body: HealthStatus = {
        ok: true,
        mode: config.mode,
        version: config.version,
        uptimeMs: Math.floor(process.uptime() * 1000),
        activeTasks: agent.activeTaskCount,
      };
      sendJson(res, 200, body);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/status") {
      sendJson(res, 200, {
        mode: config.mode,
        version: config.version,
        activeTasks: agent.activeTaskCount,
        knownTasks: tasks.size,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/tasks") {
      const body = (await readJson(req)) as OpenCoreSubmitBody;
      if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }

      const id = body.id?.trim() || randomUUID();
      if (tasks.has(id)) {
        sendJson(res, 409, { error: `task ${id} already exists` });
        return;
      }

      const record: TaskRecord = {
        events: [],
        promise: Promise.resolve({} as AgentResult),
      };
      tasks.set(id, record);

      record.promise = agent
        .run({
          id,
          prompt: body.prompt,
          ...(body.baseBranch !== undefined ? { baseBranch: body.baseBranch } : {}),
          ...(body.testCommand !== undefined ? { testCommand: body.testCommand } : {}),
          ...(body.contextPaths !== undefined ? { contextPaths: body.contextPaths } : {}),
          ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        })
        .then((result) => {
          record.result = result;
          return result;
        });

      // Fire-and-forget retention: keep result for polling clients.
      void record.promise.catch(() => undefined);

      sendJson(res, 202, {
        id,
        status: "queued",
        poll: `/v1/tasks/${id}`,
      });
      return;
    }

    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (method === "GET" && taskMatch) {
      const id = decodeURIComponent(taskMatch[1] ?? "");
      const rec = tasks.get(id);
      if (!rec) {
        sendJson(res, 404, { error: "task not found" });
        return;
      }
      sendJson(res, 200, {
        id,
        status: rec.result?.status ?? "running",
        result: rec.result ?? null,
        events: rec.events,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/tasks/sync") {
      // Synchronous convenience path for simple clients / integration tests.
      const body = (await readJson(req)) as OpenCoreSubmitBody;
      if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        sendJson(res, 400, { error: "prompt is required" });
        return;
      }
      const id = body.id?.trim() || randomUUID();
      const result = await agent.run({
        id,
        prompt: body.prompt,
        ...(body.baseBranch !== undefined ? { baseBranch: body.baseBranch } : {}),
        ...(body.testCommand !== undefined ? { testCommand: body.testCommand } : {}),
        ...(body.contextPaths !== undefined ? { contextPaths: body.contextPaths } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
      sendJson(res, result.status === "succeeded" ? 200 : 422, result);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.PORT, config.HOST, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind open-core HTTP server");
  }

  const host = config.HOST === "0.0.0.0" ? "127.0.0.1" : config.HOST;
  const port = address.port;
  log.info("open-core listening", { host: config.HOST, port });

  const close = async (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  if (installSignals) {
    const shutdown = (): void => {
      log.info("open-core shutting down");
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  return {
    server,
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    agent,
    close,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    if (total > 2 * 1024 * 1024) {
      throw new Error("request body too large");
    }
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}
