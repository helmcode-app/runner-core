# Open-core HTTP + WebSocket API

Standalone HTTP + WebSocket API for local / iPad clients.

| Item | Value |
| ------ | ------- |
| Mode | `HELM_MODE=open-core` (only supported mode) |
| Default bind | `0.0.0.0:8080` (`HOST` / `PORT`) |
| Content type | `application/json; charset=utf-8` |
| Auth | Per-device Bearer from setup enroll. All routes **except** `GET /health` and the public setup/enroll routes require `Authorization: Bearer`. |
| Implementation | `services/runner/src/modes/open-core/` |

Agent product API: [sessions.md](./sessions.md). VFS: [vfs.md](./vfs.md). Terminal: [terminal.md](./terminal.md).

---

## HTTP

| Method | Path | Auth | Description |
| -------- | ------ | ------ | ------------- |
| `GET` | `/` | no | Setup page (pairing + GitHub + clone) |
| `GET` | `/health` | no | Process liveness |
| `*` | `/v1/setup*` | mixed | First-boot setup (see [setup.md](./setup.md)) |
| `GET` | `/v1/status` | yes* | Runtime status |
| `*` | `/v1/workspaces*` | yes* | Workspace catalog (see [workspaces.md](./workspaces.md)) |
| `*` | `/v1/sessions/*` | yes* | Agent sessions (see [sessions.md](./sessions.md)) |
| `*` | `/v1/vfs/*` | yes* | VFS HTTP helpers (see [vfs.md](./vfs.md)) |

## WebSocket

| Path | Auth | Description |
|------|------|-------------|
| `/v1/vfs` | yes* | VFS JSON-RPC |
| `/v1/terminal` | yes* | WebSSH (in-process PTY). Alias: `/api/v1/terminal/ws` |

\* Required once a device token exists. A runner with no devices still rejects these routes.

---

## `GET /health`

```json
{
  "ok": true,
  "mode": "open-core",
  "version": "0.1.0",
  "uptimeMs": 1234,
  "sessionsEnabled": false
}
```

## `GET /v1/status`

```json
{
  "mode": "open-core",
  "version": "0.1.0",
  "sessionsEnabled": true,
  "agentHarness": "opencode",
  "agentTransport": "stdio",
  "sessionsManaged": true,
  "authRequired": false,
  "vfsEnabled": true,
  "terminalEnabled": true
}
```

`agentHarness` is the ACP Server (`opencode`, `claude`, `codex`, `cursor`, `grok`).  
`AGENT_PROVIDER` is only the LLM vendor **inside** a multi-provider shell (OpenCode).
