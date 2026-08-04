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
├── entrypoint.ts
├── config.ts                  # zod env (grouped; envBool)
├── logger.ts
├── types.ts
├── agent/
│   ├── engine.ts              # HelmCodeAgentEngine
│   ├── task-control.ts        # abort + timeout budget
│   ├── result-builder.ts      # success / fail / cancel results
│   ├── heal-loop.ts           # runTestAndHeal
│   ├── llm-apply.ts
│   ├── contextBuilder.ts
│   ├── params.ts / prompts.ts / events.ts
│   ├── protocol.ts            # agent/* methods + RPC helpers
│   ├── parse-run.ts           # agent/run param validation
│   ├── router.ts              # JSON-RPC controller
│   ├── ws.ts                  # WebSocket /v1/agent
│   ├── pipeline.ts            # HTTP / SaaS façade
│   ├── git.ts / llm.ts / patch.ts / test-runner.ts
│   └── index.ts
├── http/                      # auth, JSON, shared WS upgrade
├── modes/
│   ├── open-core/             # server + routes + task-store
│   └── commercial-saas/
├── terminal/                  # WebSSH: WS ↔ in-process PTY
├── vfs/                       # helm-vfs bridge + WS
└── util/
```

## Unified ingress

| Path | Protocol |
|------|----------|
| `/health`, `/v1/tasks`, … | HTTP |
| `/v1/vfs` | WebSocket JSON-RPC |
| `/v1/agent` | WebSocket JSON-RPC |
| `/v1/terminal` | WebSocket binary + control JSON |

Auth: `OPENCORE_API_TOKEN` as Bearer or Upgrade `?token=`.

## Agent pipeline

```
agent/run → worktree → contextPaths → LLM patches → test/heal → commit/push
```

| Credential | Purpose |
|------------|---------|
| `OPENCORE_API_TOKEN` | HTTP + WebSockets |
| `GITHUB_TOKEN` / `githubToken` | git fetch / push |
| `LLM_API_KEY` | chat completions |

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
| Orchestration steps | `agent/engine.ts` |
| Cancel / timeout | `agent/task-control.ts` |
| Result envelopes | `agent/result-builder.ts` |
| Self-heal | `agent/heal-loop.ts` |
| LLM patches | `agent/llm-apply.ts`, `llm.ts`, `patch.ts` |
| RPC methods / codes | `agent/protocol.ts`, `router.ts` |
| `agent/run` params | `agent/parse-run.ts` |
| Agent WebSocket | `agent/ws.ts` |
| Shared WS upgrade | `http/ws-upgrade.ts` |
| Terminal | `terminal/` |
| VFS | `vfs/` + Go `services/vfs` |
| HTTP routes | `modes/open-core/routes.ts` |
| Env | `config.ts` |
