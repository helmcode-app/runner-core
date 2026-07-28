# runner-core

Headless AI agent orchestration engine for [HelmCode](https://github.com/helmcode-app). Runs as a long-lived daemon inside an isolated Linux sandbox (Docker / Firecracker), drives Git worktree isolation, LLM file patches, a self-healing test loop, and secure push-back to GitHub.

## Modes (`HELM_MODE`)

| Mode | Role |
|------|------|
| `open-core` | Standalone monolithic HTTP API on `:8080` for the iPad / local client. No commercial billing or gateway routing. |
| `commercial-saas` | Elastic headless worker. Controlled by an external commercial gateway over private JSON-RPC. |

## Architecture

```
entrypoint.ts
├── open-core        HTTP :8080  →  AgentPipeline
└── commercial-saas  JSON-RPC    →  AgentPipeline
                                      │
                                      ├─ git fetch (/app/main_repo)
                                      ├─ git worktree add -b aero-agent/<id>
                                      ├─ LLM patch files in worktree
                                      ├─ self-healing tests (≤3 retries)
                                      ├─ commit + push (GITHUB_TOKEN)
                                      └─ git worktree remove
```

## Tests

**Local (needs Node 20+):**

```bash
npm test                 # unit + integration
npm run test:unit
npm run test:integration
```

**Docker only (no host Node / npm install):**

```bash
docker compose run --rm --build test   # typecheck + full suite
./scripts/docker-test.sh               # same via helper
./scripts/docker-test.sh smoke         # open-core on :18080
```

Full guide: [docs/testing-docker.md](./docs/testing-docker.md).

CI: [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs typecheck + tests on every push/PR (`npm test` and Docker test target).

Uses Node's built-in test runner via `tsx` (no extra test framework).
## Quick start

```bash
cp .env.example .env
npm install
npm run build

# Standalone (iPad / local)
HELM_MODE=open-core \
MAIN_REPO_PATH=/path/to/repo \
GITHUB_TOKEN=ghp_… \
LLM_API_KEY=sk-… \
npm start

# Commercial worker
HELM_MODE=commercial-saas \
GATEWAY_URL=http://gateway.internal:9000 \
GATEWAY_TOKEN=… \
MAIN_REPO_PATH=/app/main_repo \
npm start
```

### Docker

```bash
docker build -t helmcode/runner-core .
docker run --rm -p 8080:8080 \
  -e HELM_MODE=open-core \
  -e LLM_API_KEY \
  -e GITHUB_TOKEN \
  -v /path/to/repo:/app/main_repo \
  helmcode/runner-core
```

## API contracts

Full request/response schemas (English):

| Document | Description |
|----------|-------------|
| [docs/api/open-core.md](./docs/api/open-core.md) | open-core HTTP API (`/health`, `/v1/*`) |
| [docs/api/commercial-saas.md](./docs/api/commercial-saas.md) | commercial-saas JSON-RPC (worker → gateway) |
| [docs/api/shared-types.md](./docs/api/shared-types.md) | Shared types (`AgentResult`, events, enums) |

### open-core HTTP (summary)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness (no auth) |
| `GET` | `/v1/status` | Runtime status |
| `POST` | `/v1/tasks` | Async submit → `202` |
| `GET` | `/v1/tasks/:id` | Poll task + events |
| `POST` | `/v1/tasks/:id/cancel` | Cancel in-flight task |
| `POST` | `/v1/tasks/sync` | Synchronous run |

Auth: set `OPENCORE_API_TOKEN` and send `Authorization: Bearer <token>`. Hard timeout: `TASK_TIMEOUT_MS` or per-task `timeoutMs`.

### commercial-saas JSON-RPC (summary)

Outbound methods against `GATEWAY_URL`:

- `worker.register` / `worker.deregister` / `worker.heartbeat`
- `task.lease` → `{ task, github_token?, lease_id? }`
- `task.progress` → buffered status events
- `task.complete` → final `AgentResult`

## Environment

See [`.env.example`](./.env.example). Critical vars:

- `HELM_MODE` — `open-core` \| `commercial-saas`
- `MAIN_REPO_PATH` — shared git checkout (`/app/main_repo`)
- `WORKSPACES_PATH` — worktree parent (`/app/workspaces`)
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` — OpenAI-compatible API
- `GITHUB_TOKEN` — push credentials
- `MAX_TEST_RETRIES` — self-healing budget (default `3`)

## License

MIT © helmcode-app
