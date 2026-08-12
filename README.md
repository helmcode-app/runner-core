# runner-core

Headless sandbox daemon for [HelmCode](https://github.com/helmcode-app):  
**Node.js open-core** (agent sessions via OpenCode, VFS, terminal) + **Go VFS**.

## Repository layout

```
runner-core/
├── services/
│   ├── runner/          # @helmcode/runner — open-core HTTP/WS API
│   ├── vfs/             # @helmcode/vfs   — Go helm-vfs (JSON-RPC over stdio)
│   └── webssh/          # optional Go WebSSH sidecar
├── docs/                # API contracts
├── scripts/             # Docker helpers
├── Dockerfile           # multi-service image (test | build | runtime | smoke)
├── compose.yaml
├── compose.dev.yaml     # host repo bind-mount for iPad / VFS
└── package.json         # workspace root (npm workspaces)
```

| Service | Path | Role |
|---------|------|------|
| **runner** | [`services/runner`](./services/runner) | HTTP/WS control plane, sessions adapter, spawns `helm-vfs` |
| **vfs** | [`services/vfs`](./services/vfs) | Workspace filesystem (`vfs/*` JSON-RPC) |

## Architecture

```
iPad / client
    │  HTTP + WebSocket  (Bearer OPENCORE_API_TOKEN)
    ▼
services/runner (Node)
    ├── modes/open-core/   routes + server
    ├── sessions/          public /v1/sessions/* (Helm DTOs)
    ├── opencode/          adapter ──HTTP──► opencode serve (:4096)
    ├── terminal/          in-process PTY → WS /v1/terminal
    └── vfs/               ──stdio JSON-RPC──► services/vfs (helm-vfs)
```

**Agent product path:** `/v1/sessions/*` → OpenCode. Model credentials live **inside OpenCode**, not in runner `LLM_*` (removed).

## Quick start

```bash
npm ci
npm run build:vfs
npm run test:all

export HELM_MODE=open-core
export MAIN_REPO_PATH=/path/to/repo
export HELM_VFS_BIN=$PWD/services/vfs/bin/helm-vfs
npm start
# → http://127.0.0.1:8080
```

Copy [`.env.example`](./.env.example) to `.env` and fill what you need. Empty optional keys are treated as unset.

## Docker packaging

| Target | Purpose |
|--------|---------|
| `test` | Typecheck + full Node suite |
| `runtime` | Production daemon |
| `smoke` | Runtime + in-container git fixture |

```bash
docker build --target runtime -t helmcode/runner-core:local .
docker compose run --rm --build test
docker compose up --build smoke
# → http://127.0.0.1:18080

export HOST_REPO=/absolute/path/to/your/git/repo
docker compose -f compose.yaml -f compose.dev.yaml up --build dev
```

Full Docker notes: [`docs/testing-docker.md`](./docs/testing-docker.md).

**OpenCode is not baked into the image.** With managed mode the runner installs
`opencode-ai` at boot into `OPENCODE_PREFIX` and runs `opencode serve`. First
managed boot needs outbound network. Persist `/app/.opencode` (compose.dev volume
`dev-opencode`) so restarts skip the download.

## Credentials & OpenCode

```
iPad / curl
    │  Authorization: Bearer <OPENCORE_API_TOKEN>   (optional if token empty)
    ▼
runner  /v1/sessions/*  |  /v1/vfs  |  /v1/terminal
    │  Authorization: Basic …                     if OPENCODE_SERVER_PASSWORD set
    ▼
opencode serve (:4096)   ← managed: started by runner after boot install
    │  Provider API keys (Anthropic / OpenAI / …)
    ▼
LLM
```

| Variable | Purpose |
|----------|---------|
| `OPENCORE_API_TOKEN` | Client → runner Bearer |
| `OPENCODE_ENABLED` | Expose `/v1/sessions/*` |
| `OPENCODE_MANAGED` | Install + spawn serve at boot |
| `OPENCODE_GO_API_KEY` | OpenCode **Go** → `opencode-go` in auth.json (set alone for Go-only catalog) |
| `OPENCODE_ZEN_API_KEY` | OpenCode **Zen** → `opencode` in auth.json |
| `OPENCODE_VERSION` / `PREFIX` / `UPDATE_*` | Managed install knobs |
| `OPENCODE_BASE_URL` | OpenCode HTTP base |
| `OPENCODE_SERVER_PASSWORD` | Optional Basic to serve (not the model key) |

Managed mode needs **at least one** of `OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY`.
Model list only includes providers you configured (same key string may be used in both).

## Test Agent Sessions

### Managed (recommended in Docker)

```bash
export HOST_REPO=/absolute/path/to/your/git/repo
export OPENCODE_ENABLED=true
export OPENCODE_MANAGED=true
export OPENCODE_GO_API_KEY=oc-…   # Go subscription (or OPENCODE_ZEN_API_KEY for Zen)
export OPENCODE_DEFAULT_MODEL=opencode-go/glm-5.1

docker compose -f compose.yaml -f compose.dev.yaml up --build dev
```

Local process (same keys, no auth mount):

```bash
export OPENCODE_ENABLED=true
export OPENCODE_MANAGED=true
export OPENCODE_GO_API_KEY=oc-…
export OPENCODE_PREFIX=$PWD/.opencode-prefix
export OPENCODE_DEFAULT_MODEL=opencode-go/glm-5.1
npm start
```

### Probe

```bash
curl -s http://127.0.0.1:8080/v1/sessions/health | jq
curl -s -X POST http://127.0.0.1:8080/v1/sessions \
  -H 'content-type: application/json' -d '{}' | jq
```

## API docs

| Document | Description |
|----------|-------------|
| [docs/api/open-core.md](./docs/api/open-core.md) | open-core HTTP + auth |
| [docs/api/sessions.md](./docs/api/sessions.md) | Agent sessions `/v1/sessions/*` |
| [docs/api/opencode.md](./docs/api/opencode.md) | OpenCode adapter (internal) |
| [docs/api/vfs.md](./docs/api/vfs.md) | VFS protocol |
| [docs/api/terminal.md](./docs/api/terminal.md) | Terminal WebSSH |
| [docs/testing-docker.md](./docs/testing-docker.md) | Docker-only testing |

## Scripts (root)

| Script | Action |
|--------|--------|
| `npm run build` | Build runner (TypeScript) |
| `npm run build:vfs` | Build `helm-vfs` |
| `npm run build:webssh` | Build `helm-webssh` |
| `npm test` | Runner tests |
| `npm run test:go` | VFS Go tests |
| `npm run test:all` | Go + Node tests |
| `npm start` | Start runner entrypoint |
| `npm run dev` | Runner dev (tsx watch) |

## License

MIT © helmcode-app
