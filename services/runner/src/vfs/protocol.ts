/**
 * VFS JSON-RPC method names and wire types.
 * Keep method strings in sync with services/vfs/internal/vfs/protocol.go.
 */

export const VfsMethod = {
  Initialize: "vfs/initialize",
  Read: "vfs/read",
  /** Bounded segment read (offset + limit); preferred for large files. */
  ReadChunk: "vfs/read_chunk",
  Write: "vfs/write",
  Shutdown: "vfs/shutdown",
  DidChange: "vfs/didChange",
} as const;

/** Default client chunk size (bytes); matches Go DefaultChunkLimit. */
export const VFS_DEFAULT_CHUNK_LIMIT = 64 * 1024;

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
  /**
   * Git origin in display form (e.g. github.com/org/repo).
   * Empty when unavailable — clients must not use `root` (e.g. /app/main_repo) as UI remote.
   */
  remote?: string;
  /**
   * Current HEAD branch name. Empty when detached HEAD or not a git repo —
   * clients must not invent "main".
   */
  branch?: string;
  entries: VfsTreeEntry[];
}

export interface VfsReadResult {
  path: string;
  content: string;
  size: number;
}

export interface VfsReadChunkParams {
  path: string;
  offset: number;
  limit?: number;
}

export interface VfsReadChunkResult {
  path: string;
  content: string;
  offset: number;
  bytes_read: number;
  is_eof: boolean;
  file_size: number;
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
