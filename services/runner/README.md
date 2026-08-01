# @helmcode/runner

Node.js / TypeScript agent orchestration daemon for HelmCode.

## Modes

| `HELM_MODE` | Role |
|-------------|------|
| `open-core` | HTTP + WebSocket API for iPad / local clients |
| `commercial-saas` | Headless worker controlled by commercial gateway |

## Layout

```
services/runner/src/
├── entrypoint.ts          # HELM_MODE bifurcation
├── config.ts              # env validation (zod)
├── logger.ts
├── types.ts               # shared domain types
├── agent/                 # worktree pipeline, git, LLM, tests
│   ├── pipeline.ts
│   ├── git.ts
│   ├── llm.ts
│   ├── patch.ts
│   └── test-runner.ts
├── http/                  # shared HTTP helpers (auth, JSON)
├── modes/
│   ├── open-core/         # standalone API + in-memory task store
│   └── commercial-saas/   # gateway worker loop
├── vfs/                   # helm-vfs bridge + WS/HTTP gateway
└── util/                  # process, fs, errors
```

## Develop

From **repo root** (npm workspaces):

```bash
npm ci
npm run build:vfs
npm run typecheck
npm test
npm run dev
```

## VFS

When `VFS_ENABLED=true`, open-core starts `helm-vfs` and exposes:

- `ws://host:port/v1/vfs`
- `POST /v1/vfs/rpc`
- `GET /v1/vfs/status`

Binary: `HELM_VFS_BIN` or `services/vfs/bin/helm-vfs` / `/app/bin/helm-vfs`.
