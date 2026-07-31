# @helmcode/runner

Node.js / TypeScript agent orchestration daemon for HelmCode.

## Modes

| `HELM_MODE` | Role |
|-------------|------|
| `open-core` | HTTP + WebSocket API for iPad / local clients |
| `commercial-saas` | Headless worker controlled by commercial gateway |

## Layout

```
services/runner/
├── package.json
├── tsconfig.json
├── src/
│   ├── entrypoint.ts
│   ├── core/          # agent, git, llm, patch, tests
│   ├── modes/         # open-core, commercial-saas
│   ├── vfs/           # VFS bridge, HTTP/WS gateway, protocol types
│   └── util/
└── test/
```

## Develop

From **repo root** (npm workspaces):

```bash
npm ci
npm run build:vfs          # sibling Go binary for VFS tests
npm run typecheck
npm test
npm run dev                # tsx watch
```

From this package:

```bash
npm run build && npm start
```

## VFS

When `VFS_ENABLED=true`, open-core starts `helm-vfs` and exposes:

- `ws://host:port/v1/vfs`
- `POST /v1/vfs/rpc`
- `GET /v1/vfs/status`

Binary resolution: `HELM_VFS_BIN` or `services/vfs/bin/helm-vfs` / `/app/bin/helm-vfs`.
