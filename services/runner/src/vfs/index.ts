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
  type VfsGateway,
} from "./gateway.js";
export { handleVfsHttp, type VfsHttpContext } from "./http.js";
export {
  JsonRpcCode,
  VfsMethod,
  type JsonRpcErrorBody,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type VfsChangeType,
  type VfsDidChangeParams,
  type VfsEntryType,
  type VfsInitializeResult,
  type VfsMethodName,
  type VfsReadResult,
  type VfsTreeEntry,
  type VfsWriteResult,
} from "./protocol.js";
