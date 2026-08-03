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
├── config.ts                  # zod env (+ strip placeholder GITHUB_TOKEN)
├── logger.ts
├── types.ts                   # shared domain types
├── agent/                     # orchestration core
│   ├── agentEngine.ts         # HelmCodeAgentEngine (pipeline orchestrator)
│   ├── heal-loop.ts           # recursive runTestAndHeal
│   ├── llm-apply.ts           # LLM → structured patches → disk
│   ├── contextBuilder.ts      # surgical contextPaths-only loader
│   ├── params.ts / prompts.ts / events.ts
│   ├── agentRouter.ts         # JSON-RPC agent/* controller
│   ├── agentWs.ts             # WebSocket /v1/agent gateway
│   ├── pipeline.ts            # AgentPipeline façade (HTTP / SaaS)
│   ├── git.ts / llm.ts / patch.ts / test-runner.ts
│   └── index.ts
├── http/                      # auth + JSON body helpers
├── modes/
│   ├── index.ts               # startMode()
│   ├── open-core/
│   │   ├── server.ts          # listen / shutdown (+ agent + vfs WS)
│   │   ├── routes.ts          # HTTP dispatch
│   │   └── task-store.ts      # in-memory tasks
│   └── commercial-saas/
├── vfs/                       # helm-vfs bridge + WS gateway
└── util/                      # process, fs, errors, github-token
```

## Agent pipeline (fixed)

```
agent/run
  → git fetch + worktree aero-agent/<taskId>
  → ContextBuilder(contextPaths only)
  → LLM structured full-file patches
  → detect/run testCommand (self-heal ≤ maxCycles)
  → git commit + push
  → cleanup worktree
```

Credentials:

| Env / field | Purpose |
|-------------|---------|
| `OPENCORE_API_TOKEN` | Bearer for HTTP + `/v1/vfs` + `/v1/agent` |
| `GITHUB_TOKEN` / `agent/run.githubToken` | git fetch / push (real PAT only) |
| `LLM_API_KEY` | chat completions for patches |

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
| Orchestration steps / timeout / cancel | `agent/agentEngine.ts` |
| Self-heal recursion | `agent/heal-loop.ts` |
| LLM patch apply | `agent/llm-apply.ts`, `agent/llm.ts`, `agent/patch.ts` |
| Surgical context | `agent/contextBuilder.ts` |
| WebSocket `agent/run` | `agent/agentRouter.ts`, `agent/agentWs.ts` |
| New HTTP route | `modes/open-core/routes.ts` |
| Task lifecycle API | `modes/open-core/task-store.ts` |
| VFS RPC methods | `vfs/protocol.ts` + Go `services/vfs` |
| Env vars | `config.ts` |
| GitHub PAT placeholders | `util/github-token.ts` |
