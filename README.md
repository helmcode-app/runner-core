# runner-core

Headless AI agent orchestration engine for [HelmCode](https://github.com/helmcode-app).  
Long-lived sandbox daemon: **Node.js orchestrator** + **Go VFS** in a symmetric monorepo.

## Repository layout

```
runner-core/
├── services/
│   ├── runner/          # @helmcode/runner — Node.js agent API (open-core / commercial-saas)
│   └── vfs/             # @helmcode/vfs   — Go helm-vfs (JSON-RPC over stdio)
├── docs/                # API contracts
├── scripts/             # Docker helpers
├── Dockerfile           # multi-service image
├── compose.yaml
└── package.json         # workspace root (npm workspaces)
```

| Service | Path | Role |
|---------|------|------|
| **runner** | [`services/runner`](./services/runner) | HTTP/WS control plane, agent pipeline, spawns `helm-vfs` |
| **vfs** | [`services/vfs`](./services/vfs) | High-performance workspace filesystem (`vfs/*` JSON-RPC) |

## Architecture

```
iPad / client
    │  HTTP + WebSocket
    ▼
services/runner (Node)
    ├── modes/          open-core (routes + task-store) | commercial-saas
    ├── agent/          pipeline · turn · heal · git · llm
    └── vfs/            ──stdio JSON-RPC──► services/vfs (helm-vfs)
```

## Quick start

```bash
# Install Node workspace
npm ci

# Build Go VFS binary
npm run build:vfs

# Typecheck + tests (both stacks)
npm run test:all

# Run open-core (from repo root)
export HELM_MODE=open-core
export MAIN_REPO_PATH=/path/to/repo
export HELM_VFS_BIN=$PWD/services/vfs/bin/helm-vfs
npm start
```

### Docker

```bash
docker compose run --rm --build test
docker compose up --build smoke   # http://127.0.0.1:18080  (in-container fixture repo)
```

**Dev with a host repository** (for iPad / VFS testing) — see [`compose.dev.yaml`](./compose.dev.yaml):

```bash
# Set absolute path to a git checkout on the host, then:
export HOST_REPO=/path/to/your/repo
docker compose -f compose.yaml -f compose.dev.yaml up --build dev
# → http://127.0.0.1:18080   (MAIN_REPO_PATH=/app/main_repo bind-mounted from HOST_REPO)
```

## API docs

| Document | Description |
|----------|-------------|
| [docs/api/open-core.md](./docs/api/open-core.md) | open-core HTTP + cancel + auth |
| [docs/api/commercial-saas.md](./docs/api/commercial-saas.md) | commercial-saas JSON-RPC |
| [docs/api/vfs.md](./docs/api/vfs.md) | VFS protocol |
| [docs/api/shared-types.md](./docs/api/shared-types.md) | Shared types |
| [docs/testing-docker.md](./docs/testing-docker.md) | Docker-only testing |

## Scripts (root)

| Script | Action |
|--------|--------|
| `npm run build` | Build runner (TypeScript) |
| `npm run build:vfs` | Build `helm-vfs` |
| `npm test` | Runner tests |
| `npm run test:go` | VFS Go tests |
| `npm run test:all` | Go + Node tests |
| `npm start` | Start runner entrypoint |

## License

MIT © helmcode-app
