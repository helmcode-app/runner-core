# runner-core

Headless sandbox daemon for [HelmCode](https://github.com/helmcode-app):  
**Node.js open-core** (agent sessions via ACP → OpenCode, VFS, terminal) + **Go VFS**.

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
    │  HTTP + WebSocket  (per-device Bearer)
    ▼
services/runner (Node)
    ├── modes/open-core/   routes + server
    ├── sessions/          public /v1/sessions/* (Helm DTOs)
    ├── agent/             ACP Client + gateway ──stdio──► harness ACP Server
    │                        default: opencode acp
    ├── terminal/          in-process PTY → WS /v1/terminal
    └── vfs/               ──stdio JSON-RPC──► services/vfs (helm-vfs)
```

**Agent product path:** `/v1/sessions/*` → Agent Gateway (ACP Client) → harness ACP Server.
Default harness is OpenCode. Single-vendor peers (`claude` / `codex` / `cursor` / `grok`) take `AGENT_HARNESS` + `AGENT_API_KEY` only.

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
| -------- | --------- |
| `test` | Typecheck + full Node suite |
| `runtime` | Production daemon |
| `smoke` | Runtime + in-container git fixture |

```bash
docker build --target runtime -t helmcode/runner-core:local .
docker compose run --rm --build test
docker compose up --build smoke
# → http://127.0.0.1:18080

# Optional: bind a local git checkout. Omit to pair + clone from the setup page.
# export HOST_REPO=/absolute/path/to/your/git/repo
docker compose -f compose.yaml -f compose.dev.yaml up --build dev
```

Full Docker notes: [`docs/testing-docker.md`](./docs/testing-docker.md).

**Harness CLIs are not baked into the image.** Runner starts with ACP **off**.
The app enables a harness via `PUT /v1/agent` (Update); only then does the
runner install the package (OpenCode: `/app/.opencode` / `~/.helm/opencode`;
others: `/app/.helm/<id>`; Cursor: `~/.local/bin`) and spawn ACP. That step
needs outbound network. Persist `/app/.opencode` and `/app/.helm` (compose.dev
volumes) so later enables skip the download. Install knobs live in
`agent/harnesses/catalog.ts` + overlays, not env.

## Credentials & agent (ACP)

```
iPad / curl
    │  Authorization: Bearer <pairing token>
    ▼
runner  /v1/sessions/*  |  /v1/vfs  |  /v1/terminal
    │  ACP (stdio ndjson)
    ▼
opencode acp   ← managed: installed + started after app Update
    │  Provider API keys (from auth.json)
    ▼
LLM
```

| Variable | Purpose |
| ---------- | --------- |
| `REVIEW_SETUP_CODE` | Optional non-expiring reusable enroll code for App Review / demos (`XXXX-XXXX`) |
| `SESSIONS_ENABLED` | Optional bootstrap when `agent.json` missing (product: `PUT /v1/agent`) |
| `AGENT_HARNESS` | Bootstrap ACP Server id when env-enabled: `opencode`, `claude`, `codex`, `cursor`, `grok` |
| `AGENT_PROVIDER` | Inside OpenCode: `opencode-go` (aliases `opencode` / `opencode-go-plus` / `opencode-zen`). Unused for claude/codex/cursor/grok |
| `AGENT_API_KEY` | OpenCode Go key (also unlocks free `opencode/*` models) / single-vendor harness keys |
| `AGENT_DEFAULT_MODEL` | Default `provider/model` when prompt omits `model` (e.g. `opencode/beam-free`) |

OpenCode sessions need `AGENT_PROVIDER=opencode-go` + `AGENT_API_KEY`. Single-vendor harnesses need `AGENT_API_KEY` only.
Install / permission / extra-model knobs are code overlays, not env. See [docs/api/harnesses.md](./docs/api/harnesses.md).

## Test Agent Sessions

### Managed (recommended in Docker)

```bash
export HOST_REPO=/absolute/path/to/your/git/repo
export SESSIONS_ENABLED=true
export AGENT_HARNESS=opencode
export AGENT_PROVIDER=opencode-go
export AGENT_API_KEY=oc-…
export AGENT_DEFAULT_MODEL=opencode-go/glm-5.1

docker compose -f compose.yaml -f compose.dev.yaml up --build dev
```

Local process (same keys):

```bash
export SESSIONS_ENABLED=true
export AGENT_HARNESS=opencode
export AGENT_PROVIDER=opencode-go
export AGENT_API_KEY=oc-…
export AGENT_DEFAULT_MODEL=opencode-go/glm-5.1
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
| ---------- | ------------- |
| [docs/api/open-core.md](./docs/api/open-core.md) | open-core HTTP + auth |
| [docs/api/sessions.md](./docs/api/sessions.md) | Agent sessions `/v1/sessions/*` |
| [docs/api/harnesses.md](./docs/api/harnesses.md) | `AGENT_HARNESS` catalog |
| [docs/api/opencode.md](./docs/api/opencode.md) | Default ACP Server (OpenCode) |
| [docs/design/acp-first-runtime.md](./docs/design/acp-first-runtime.md) | ACP Client / Server layout |
| [docs/design/acp-and-goose.md](./docs/design/acp-and-goose.md) | Goose as a later optional harness |
| [docs/api/vfs.md](./docs/api/vfs.md) | VFS protocol |
| [docs/api/terminal.md](./docs/api/terminal.md) | Terminal WebSSH |
| [docs/testing-docker.md](./docs/testing-docker.md) | Docker-only testing |

## Scripts (root)

| Script | Action |
| -------- | -------- |
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
