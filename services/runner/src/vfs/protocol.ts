/**
 * VFS JSON-RPC method names and wire types.
 * Keep method strings in sync with services/vfs/internal/vfs/protocol.go.
 */

export const VfsMethod = {
  Initialize: "vfs/initialize",
  Read: "vfs/read",
  Write: "vfs/write",
  Shutdown: "vfs/shutdown",
  DidChange: "vfs/didChange",
} as const;

export type VfsMethodName = (typeof VfsMethod)[keyof typeof VfsMethod];

export type VfsChangeType = "write" | "create" | "remove" | "rename";

export type VfsEntryType = "file" | "dir";

export interface VfsTreeEntry {
  path: string;
  size: number;
  type: VfsEntryType;
}

export interface VfsInitializeResult {
  root: string;
  /** Human-facing project label (git remote / env / basename). */
  name: string;
  entries: VfsTreeEntry[];
}

export interface VfsReadResult {
  path: string;
  content: string;
  size: number;
}

export interface VfsWriteResult {
  path: string;
  size: number;
}

export interface VfsDidChangeParams {
  path: string;
  type: VfsChangeType;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorBody;
  method?: string;
  params?: unknown;
}

export const JsonRpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerError: -32000,
} as const;
