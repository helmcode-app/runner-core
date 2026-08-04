# @helmcode/runner

Node.js agent orchestration daemon for HelmCode.

## Modes

| `HELM_MODE` | Role |
|-------------|------|
| `open-core` | HTTP + WebSocket API for iPad / local clients |
| `commercial-saas` | Headless worker under commercial gateway |

## Layout

```
src/
├── entrypoint.ts              # boot → modes/startMode
├── config.ts                  # zod env (grouped; envBool helper)
├── logger.ts
├── types.ts                   # shared domain types
├── agent/                     # orchestration core
│   ├── agentEngine.ts         # HelmCodeAgentEngine
│   ├── heal-loop.ts           # recursive runTestAndHeal
│   ├── llm-apply.ts           # LLM → patches → disk
│   ├── contextBuilder.ts      # contextPaths-only loader
│   ├── params.ts / prompts.ts / events.ts
│   ├── agentRouter.ts         # JSON-RPC agent/* controller
│   ├── agentWs.ts             # WebSocket /v1/agent
│   ├── pipeline.ts            # façade for HTTP / SaaS
│   ├── git.ts / llm.ts / patch.ts / test-runner.ts
│   └── index.ts
├── http/                      # auth, JSON, shared WS upgrade
│   ├── auth.ts                # Bearer + WS query token
│   ├── ws-upgrade.ts          # attachAuthenticatedUpgrade
│   └── json.ts
├── modes/
│   ├── open-core/
│   │   ├── server.ts          # listen + mount gateways
│   │   ├── routes.ts
│   │   └── task-store.ts
│   └── commercial-saas/
├── terminal/                  # WebSSH: WS ↔ in-process PTY
├── vfs/                       # helm-vfs bridge + WS gateway
└── util/                      # process, fs, errors, github-token, env
```

## Unified ingress (open-core)

Same host/port for all surfaces:

| Path | Protocol |
|------|----------|
| `/health`, `/v1/tasks`, … | HTTP |
| `/v1/vfs` | WebSocket JSON-RPC |
| `/v1/agent` | WebSocket JSON-RPC |
| `/v1/terminal` (+ `/api/v1/terminal/ws`) | WebSocket binary + control JSON |

Auth: `OPENCORE_API_TOKEN` as `Authorization: Bearer` or Upgrade `?token=`.

## Agent pipeline

```
agent/run
  → git fetch + worktree aero-agent/<taskId>
  → ContextBuilder(contextPaths only)
  → LLM structured full-file patches
  → detect/run testCommand (self-heal ≤ maxCycles)
  → git commit + push
  → cleanup worktree
```

| Credential | Purpose |
|------------|---------|
| `OPENCORE_API_TOKEN` | HTTP + all WebSockets |
| `GITHUB_TOKEN` / `agent/run.githubToken` | git fetch / push |
| `LLM_API_KEY` | chat completions |

## Develop

From **repo root**:

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
| Orchestration / cancel / timeout | `agent/agentEngine.ts` |
| Self-heal | `agent/heal-loop.ts` |
| LLM patches | `agent/llm-apply.ts`, `llm.ts`, `patch.ts` |
| Context loading | `agent/contextBuilder.ts` |
| Agent WS methods | `agent/agentRouter.ts`, `agentWs.ts` |
| Shared WS auth / upgrade | `http/auth.ts`, `http/ws-upgrade.ts` |
| Terminal PTY | `terminal/` |
| VFS | `vfs/` + Go `services/vfs` |
| HTTP routes | `modes/open-core/routes.ts` |
| Env vars | `config.ts` |
