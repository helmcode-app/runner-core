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
├── entrypoint.ts          # boot → modes/startMode
├── config.ts              # zod env
├── logger.ts
├── types.ts               # shared domain types
├── agent/                 # orchestration core
│   ├── pipeline.ts        # AgentPipeline (lifecycle)
│   ├── turn.ts            # single LLM→patch turn
│   ├── heal.ts            # self-healing test loop
│   ├── git.ts / llm.ts / patch.ts / test-runner.ts
│   └── index.ts
├── http/                  # auth + JSON body helpers
├── modes/
│   ├── index.ts           # startMode()
│   ├── open-core/
│   │   ├── server.ts      # listen / shutdown
│   │   ├── routes.ts      # HTTP dispatch
│   │   └── task-store.ts  # in-memory tasks
│   └── commercial-saas/
├── vfs/                   # helm-vfs bridge + WS gateway
└── util/                  # process, fs, errors
```

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
| Agent steps / timeout / cancel | `agent/pipeline.ts` |
| LLM prompt / patch apply | `agent/turn.ts`, `agent/llm.ts` |
| Test retry loop | `agent/heal.ts` |
| New HTTP route | `modes/open-core/routes.ts` |
| Task lifecycle API | `modes/open-core/task-store.ts` |
| VFS RPC methods | `vfs/protocol.ts` + Go `services/vfs` |
| Env vars | `config.ts` |
