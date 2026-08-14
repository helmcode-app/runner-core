/**
 * Long-lived ACP client connection over a bidirectional ndjson stream.
 */

import * as acp from "@agentclientprotocol/sdk";
import type { AppConfig } from "../../config.js";
import type { Logger } from "../../logger.js";
import { AgentRuntimeError } from "../errors.js";
import { resolvePermission } from "../permissions.js";
import { resolveAgentSettings } from "../settings.js";

type ClientContext = Parameters<
  Parameters<ReturnType<typeof acp.client>["connectWith"]>[1]
>[0];

export type SessionUpdateHandler = (params: {
  sessionId: string;
  update: Record<string, unknown>;
}) => void | Promise<void>;

export interface AcpConnection {
  readonly protocolVersion: number;
  readonly agentName: string | undefined;
  request: ClientContext["request"];
  notify: ClientContext["notify"];
  close(): Promise<void>;
}

/**
 * Open an ACP client on `stream` and keep it alive until `close()`.
 */
export async function connectAcpClient(options: {
  config: AppConfig;
  logger: Logger;
  stream: acp.Stream;
  onSessionUpdate: SessionUpdateHandler;
  clientName?: string;
}): Promise<AcpConnection> {
  const { config, logger, stream, onSessionUpdate } = options;
  const log = logger.child({ component: "acp-connection" });

  let resolveReady!: (ctx: ClientContext) => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<ClientContext>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let settleClose!: () => void;
  const closeRequested = new Promise<void>((resolve) => {
    settleClose = resolve;
  });

  let protocolVersion = acp.PROTOCOL_VERSION;
  let agentName: string | undefined;
  let connectError: unknown;
  let readySettled = false;

  const settleReady = (fn: () => void): void => {
    if (readySettled) return;
    readySettled = true;
    fn();
  };

  const connectPromise = acp
    .client({ name: options.clientName ?? "helm-runner" })
    .onRequest(
      acp.methods.client.session.requestPermission,
      async ({ params }) => {
        const response = resolvePermission(resolveAgentSettings(), {
          options: (params.options ?? []).map((o) => ({
            optionId: o.optionId,
            ...(o.name != null ? { name: o.name } : {}),
            ...(o.kind != null ? { kind: o.kind } : {}),
          })),
          ...(params.toolCall?.title
            ? { toolCall: { title: params.toolCall.title } }
            : {}),
        });
        log.debug("acp permission resolved", {
          policy: resolveAgentSettings().permissionPolicy,
          tool: params.toolCall?.title,
          outcome: response.outcome.outcome,
        });
        return response;
      },
    )
    .onNotification(
      acp.methods.client.session.update,
      async ({ params }) => {
        await onSessionUpdate({
          sessionId: params.sessionId,
          update: params.update as unknown as Record<string, unknown>,
        });
      },
    )
    .connectWith(stream, async (ctx) => {
      try {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: {
            name: options.clientName ?? "helm-runner",
            version: config.version,
          },
          clientCapabilities: {
            fs: {
              readTextFile: false,
              writeTextFile: false,
            },
          },
        });
        protocolVersion = init.protocolVersion ?? acp.PROTOCOL_VERSION;
        const info = init.agentInfo as
          | { name?: string; version?: string }
          | null
          | undefined;
        agentName = info?.name ?? undefined;
        log.info("acp initialized", {
          protocolVersion,
          agentName,
          agentVersion: info?.version,
        });
        settleReady(() => resolveReady(ctx));
        await Promise.race([closeRequested, closed]);
      } catch (err) {
        connectError = err;
        settleReady(() => rejectReady(err));
        throw err;
      } finally {
        resolveClosed();
      }
    })
    .catch((err) => {
      connectError = err;
      settleReady(() => rejectReady(err));
    });

  const ctx = await ready.catch((err) => {
    throw new AgentRuntimeError(
      `ACP initialize failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  });

  const connection: AcpConnection = {
    protocolVersion,
    agentName,
    request: ctx.request.bind(ctx),
    notify: ctx.notify.bind(ctx),
    async close() {
      settleClose();
      await Promise.race([
        connectPromise,
        new Promise<void>((r) => setTimeout(r, 5_000)),
      ]);
      if (connectError) {
        log.debug("acp connection closed with error", {
          error:
            connectError instanceof Error
              ? connectError.message
              : String(connectError),
        });
      }
    },
  };
  return connection;
}
