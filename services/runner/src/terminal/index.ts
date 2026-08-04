/**
 * WebSSH terminal: WebSocket ↔ in-process PTY (node-pty).
 * Unified ingress path: `/v1/terminal` (alias `/api/v1/terminal/ws`).
 * No Docker socket / no sshd.
 */
export {
  createTerminalGateway,
  authorizeTerminalUpgrade,
  TERMINAL_WS_PATH,
  TERMINAL_WS_PATH_ALIAS,
  type TerminalGateway,
} from "./gateway.js";
export { TerminalSession, type TerminalSessionOptions } from "./session.js";
export {
  spawnLocalPty,
  resolveShellCmd,
  pickAvailableShell,
  type LocalPty,
  type LocalPtyOptions,
} from "./local-pty.js";
export {
  parseClientMessage,
  encodeServerMessage,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from "./protocol.js";
