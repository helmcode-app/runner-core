# runner-core documentation

API contracts for the HelmCode open-core daemon.

| Document | Description |
|----------|-------------|
| [Open-core HTTP API](./api/open-core.md) | Standalone server on `:8080` (`HELM_MODE=open-core`) |
| [Agent sessions](./api/sessions.md) | Product `/v1/sessions/*` (backend-agnostic) |
| [OpenCode adapter](./api/opencode.md) | Internal runtime notes (not a public API) |
| [VFS protocol](./api/vfs.md) | Go `helm-vfs` JSON-RPC + WebSocket `/v1/vfs` |
| [Terminal WebSSH](./api/terminal.md) | In-process PTY over `WS /v1/terminal` |
| [Testing in Docker](./testing-docker.md) | Docker-only test / smoke |

Source of truth for runtime behavior:

- Node: `services/runner/src/` (sessions, opencode, vfs, terminal)
- Go VFS: `services/vfs/`
- Go WebSSH sidecar (optional): `services/webssh/`
