# @helmcode/runner

Node.js open-core daemon for HelmCode: agent sessions (ACP → OpenCode), VFS, terminal.

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
├── agent/                     # ACP Client, gateway, harness supervisors
│   └── harnesses/             # ACP Server processes
│       ├── create.ts          # AGENT_HARNESS → stdio supervisor
│       ├── catalog.ts         # specs (provider policy, spawn, auth)
│       ├── stdio.ts           # shared install + spawn
│       └── opencode/          # auth.json only
├── terminal/                  # WebSSH: WS ↔ in-process PTY
├── vfs/                       # helm-vfs bridge + WS
└── util/
```

## Unified ingress

| Path | Protocol |
| ------ | ---------- |
| `/health`, `/v1/status` | HTTP |
| `/v1/agent` | Select / switch ACP harness + API key |
| `/v1/sessions/*` | Agent sessions (HTTP + SSE) |
| `/v1/vfs` | WebSocket JSON-RPC |
| `/v1/terminal` | WebSocket binary + control JSON |

Auth: per-device Bearer (setup code → enroll) or Upgrade `?ticket=`.

## Credentials

| Credential | Purpose |
|------------|---------|
| Pairing Bearer | HTTP + WebSockets (generated at setup, not env) |
| `SESSIONS_ENABLED` / `AGENT_*` | Optional bootstrap when `agent.json` missing; product path is `PUT /v1/agent` |

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
| -------- | -------- |
| Session routes / DTOs | `sessions/` |
| ACP gateway / harnesses | `agent/` |
| Shared WS upgrade | `http/ws-upgrade.ts` |
| Terminal | `terminal/` |
| VFS | `vfs/` + Go `services/vfs` |
| HTTP routes | `modes/open-core/routes.ts` |
| Env | `config.ts` |
