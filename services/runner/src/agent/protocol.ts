/**
 * Agent control-plane JSON-RPC method names and error codes.
 * Used by router + WebSocket gateway.
 */

import type { JsonRpcError, JsonRpcSuccess } from "../types.js";

export const AgentMethod = {
  Run: "agent/run",
  Cancel: "agent/cancel",
  Status: "agent/status",
  List: "agent/list",
  /** Server → client push */
  Progress: "agent/progress",
  Done: "agent/done",
} as const;

export type AgentMethodName =
  (typeof AgentMethod)[keyof typeof AgentMethod];

export const AgentJsonRpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerError: -32000,
  Conflict: -32001,
  NotFound: -32002,
} as const;

export function successResponse<T>(
  id: string | number | null,
  result: T,
): JsonRpcSuccess<T> {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}
