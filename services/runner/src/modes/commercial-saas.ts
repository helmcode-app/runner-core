import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { AgentPipeline } from "../core/agent.js";
import type { Logger } from "../logger.js";
import type {
  AgentTask,
  JsonRpcRequest,
  JsonRpcResponse,
  TaskProgressEvent,
} from "../types.js";

interface LeaseTaskParams {
  task: AgentTask;
  github_token?: string;
  lease_id?: string;
}

interface HeartbeatParams {
  worker_id: string;
  active_tasks: number;
  lease_id?: string;
}

/**
 * Elastic headless worker (HELM_MODE=commercial-saas).
 * Controlled by an external commercial gateway via private JSON-RPC over HTTP.
 * Does not expose a public client port; only talks outbound to GATEWAY_URL.
 */
export async function startCommercialSaas(
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const log = logger.child({ component: "commercial-saas" });
  const workerId =
    config.WORKER_ID?.trim() || `worker-${randomUUID().slice(0, 8)}`;
  const gatewayUrl = config.GATEWAY_URL;
  if (!gatewayUrl) {
    throw new Error("GATEWAY_URL is required for commercial-saas mode");
  }

  let stopping = false;
  let currentLease: string | undefined;
  const progressBuffer: TaskProgressEvent[] = [];

  const agent = new AgentPipeline({
    config,
    logger,
    onProgress: (event) => {
      progressBuffer.push(event);
      // Cap buffer to avoid unbounded growth between flushes.
      if (progressBuffer.length > 500) {
        progressBuffer.splice(0, progressBuffer.length - 500);
      }
    },
  });

  log.info("commercial-saas worker starting", {
    workerId,
    gatewayUrl,
    pollIntervalMs: config.POLL_INTERVAL_MS,
  });

  // Register with gateway.
  await rpc(config, log, "worker.register", {
    worker_id: workerId,
    version: config.version,
    capabilities: ["git-worktree", "self-healing-tests", "push"],
  });

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info("commercial-saas shutting down", { workerId });
    try {
      await rpc(config, log, "worker.deregister", { worker_id: workerId });
    } catch (err) {
      log.warn("deregister failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  while (!stopping) {
    try {
      // Flush progress events
      if (progressBuffer.length > 0) {
        const batch = progressBuffer.splice(0, progressBuffer.length);
        await rpc(config, log, "task.progress", {
          worker_id: workerId,
          events: batch,
        });
      }

      // Heartbeat
      const hb: HeartbeatParams = {
        worker_id: workerId,
        active_tasks: agent.activeTaskCount,
        ...(currentLease !== undefined ? { lease_id: currentLease } : {}),
      };
      await rpc(config, log, "worker.heartbeat", hb);

      // Pull next task when idle
      if (agent.activeTaskCount === 0) {
        const leased = await rpc<{ task?: AgentTask; github_token?: string; lease_id?: string } | null>(
          config,
          log,
          "task.lease",
          { worker_id: workerId },
        );

        if (leased?.task) {
          const params = leased as LeaseTaskParams;
          currentLease = params.lease_id;
          const task: AgentTask = {
            ...params.task,
            id: params.task.id || randomUUID(),
            ...(params.github_token
              ? { githubToken: params.github_token }
              : {}),
          };

          log.info("leased task", { taskId: task.id, leaseId: currentLease });

          const result = await agent.run(task);

          await rpc(config, log, "task.complete", {
            worker_id: workerId,
            lease_id: currentLease,
            result,
          });
          currentLease = undefined;
        }
      }
    } catch (err) {
      log.error("worker loop error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await sleep(config.POLL_INTERVAL_MS);
  }
}

async function rpc<T = unknown>(
  config: AppConfig,
  log: Logger,
  method: string,
  params: unknown,
): Promise<T> {
  const id = randomUUID();
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-helm-worker": config.WORKER_ID ?? "anonymous",
  };
  if (config.GATEWAY_TOKEN) {
    headers.authorization = `Bearer ${config.GATEWAY_TOKEN}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(config.GATEWAY_URL!, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gateway HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    let body: JsonRpcResponse<T>;
    try {
      body = JSON.parse(text) as JsonRpcResponse<T>;
    } catch {
      throw new Error(`gateway returned non-JSON: ${text.slice(0, 300)}`);
    }

    if ("error" in body && body.error) {
      throw new Error(
        `JSON-RPC ${body.error.code}: ${body.error.message}`,
      );
    }

    return (body as { result: T }).result;
  } catch (err) {
    log.debug("rpc failed", {
      method,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
