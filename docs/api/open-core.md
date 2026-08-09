# Open-core HTTP + WebSocket API

Standalone HTTP + WebSocket API for local / iPad clients.

| Item | Value |
|------|-------|
| Mode | `HELM_MODE=open-core` (only supported mode) |
| Default bind | `0.0.0.0:8080` (`HOST` / `PORT`) |
| Content type | `application/json; charset=utf-8` |
| Auth | Optional Bearer (`OPENCORE_API_TOKEN`). When set, all routes **except** `GET /health` require `Authorization: Bearer <token>`. When unset, API is open (dev only). |
| Implementation | `services/runner/src/modes/open-core/` |

Agent product API: [sessions.md](./sessions.md). VFS: [vfs.md](./vfs.md). Terminal: [terminal.md](./terminal.md).

---

## HTTP

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | no | Process liveness |
| `GET` | `/v1/status` | yes* | Runtime status |
| `*` | `/v1/sessions/*` | yes* | Agent sessions (see [sessions.md](./sessions.md)) |
| `*` | `/v1/vfs/*` | yes* | VFS HTTP helpers (see [vfs.md](./vfs.md)) |

## WebSocket

| Path | Auth | Description |
|------|------|-------------|
| `/v1/vfs` | yes* | VFS JSON-RPC |
| `/v1/terminal` | yes* | WebSSH (in-process PTY). Alias: `/api/v1/terminal/ws` |

\* Required only when `OPENCORE_API_TOKEN` is configured.

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
  "sessionsManaged": true,
  "authRequired": false,
  "vfsEnabled": true,
  "terminalEnabled": true
}
```
