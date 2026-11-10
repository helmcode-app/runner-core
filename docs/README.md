# runner-core documentation

API contracts for the HelmCode open-core daemon.

Default agent path: **`PUT /v1/agent` → ACP Client → harness ACP Server** → `/v1/sessions/*`.

| Document | Description |
| ---------- | ------------- |
| [Open-core HTTP API](./api/open-core.md) | Standalone server on `:8080` (`HELM_MODE=open-core`) |
| [Runner setup](./api/setup.md) | Pairing QR + GitHub device flow + clone |
| [Workspaces](./api/workspaces.md) | Shared `workspaceId` for sessions / VFS / terminal |
| [Agent config](./api/agent.md) | Select / switch ACP harness + API key (`/v1/agent`) |
| [Agent sessions](./api/sessions.md) | Product `/v1/sessions/*` |
| [ACP harnesses](./api/harnesses.md) | Harness catalog (OpenCode + Claude / Codex / Cursor / Grok) |
| [OpenCode ACP harness](./api/opencode.md) | Default ACP Server (internal) |
| [ACP-first runtime](./design/acp-first-runtime.md) | Runner = ACP Client; harness = ACP Server |
| [Goose (later)](./design/acp-and-goose.md) | Optional future harness — not the default proxy |
| [VFS protocol](./api/vfs.md) | Go `helm-vfs` JSON-RPC + WebSocket `/v1/vfs` |
| [Terminal WebSSH](./api/terminal.md) | In-process PTY over `WS /v1/terminal` |
| [Testing in Docker](./testing-docker.md) | Docker-only test / smoke |

Source of truth for runtime behavior:

- Node: `services/runner/src/` (`sessions/`, `agent/`, `vfs/`, `terminal/`)
- Go VFS: `services/vfs/`
- Go WebSSH sidecar (optional): `services/webssh/`
