/**
 * VFS subsystem for open-core: Go helm-vfs bridge + HTTP/WS gateway.
 */
export {
  VfsBridge,
  resolveHelmVfsBinary,
  type VfsBridgeOptions,
} from "./bridge.js";
export {
  attachVfsWebSocket,
  createVfsGateway,
  startVfsBridge,
  VFS_WS_PATH,
  type VfsGateway,
} from "./gateway.js";
export { handleVfsHttp, type VfsHttpContext } from "./http.js";
export {
  JsonRpcCode,
  VFS_DEFAULT_CHUNK_LIMIT,
  VfsGitMethod,
  VfsMethod,
  type JsonRpcErrorBody,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type VfsChangeType,
  type VfsDidChangeParams,
  type VfsEntryType,
  type VfsGitChangeEntry,
  type VfsGitChangeStatus,
  type VfsGitCheckoutParams,
  type VfsGitCheckoutResult,
  type VfsGitDiffParams,
  type VfsGitDiffResult,
  type VfsGitMethodName,
  type VfsGitRefEntry,
  type VfsGitRefKind,
  type VfsGitRefsResult,
  type VfsGitShowParams,
  type VfsGitShowResult,
  type VfsGitStatusResult,
  type VfsInitializeResult,
  type VfsMethodName,
  type VfsReadChunkParams,
  type VfsReadChunkResult,
  type VfsReadResult,
  type VfsTreeEntry,
  type VfsWriteResult,
} from "./protocol.js";
