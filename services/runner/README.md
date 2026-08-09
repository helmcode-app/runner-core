# @helmcode/runner

Node.js open-core daemon for HelmCode: agent sessions (OpenCode), VFS, terminal.

## Mode

| `HELM_MODE` | Role |
|-------------|------|
| `open-core` | HTTP + WebSocket API for iPad / local clients (only supported mode) |

## Layout

```
src/
├── entrypoint.ts
├── config.ts
├── logger.ts
├── types.ts
├── http/                      # auth, JSON, shared WS upgrade
├── modes/
│   └── open-core/             # server + routes
├── sessions/                  # Public /v1/sessions (Helm DTOs)
├── opencode/                  # Private session-runtime adapter + managed install
├── terminal/                  # WebSSH: WS ↔ in-process PTY
├── vfs/                       # helm-vfs bridge + WS
└── util/
```

## Unified ingress

| Path | Protocol |
|------|----------|
| `/health`, `/v1/status` | HTTP |
| `/v1/sessions/*` | Agent sessions (HTTP + SSE) |
| `/v1/vfs` | WebSocket JSON-RPC |
| `/v1/terminal` | WebSocket binary + control JSON |

Auth: `OPENCORE_API_TOKEN` as Bearer or Upgrade `?token=`.

## Credentials

| Credential | Purpose |
|------------|---------|
| `OPENCORE_API_TOKEN` | HTTP + WebSockets |
| `OPENCODE_*` | Sessions: managed install/serve |
| `OPENCODE_API_KEY` | Required when managed — written to OpenCode `auth.json` |

## Develop

```bash
npm ci
npm run build:vfs
npm run typecheck
npm test
npm run dev
```

## Extension guide

| Change | Where |
|--------|--------|
| Session routes / DTOs | `sessions/` |
| OpenCode client / managed runtime | `opencode/` |
| Shared WS upgrade | `http/ws-upgrade.ts` |
| Terminal | `terminal/` |
| VFS | `vfs/` + Go `services/vfs` |
| HTTP routes | `modes/open-core/routes.ts` |
| Env | `config.ts` |
