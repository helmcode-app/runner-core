# Testing in Docker

Run the suite and smoke the HTTP API **without installing Node, npm, or project dependencies on the host**. Only Docker (and optionally `curl`) is required.

## Prerequisites

- Docker Engine 24+ (or Docker Desktop)
- Docker Compose v2 (`docker compose`)

## 1. Automated tests (recommended)

All unit + integration tests run in an ephemeral container.  
Nothing is written into your working tree (`node_modules`, etc.).

```bash
# From repo root
docker compose run --rm --build test
```

Or use the helper script:

```bash
chmod +x scripts/docker-test.sh   # once
./scripts/docker-test.sh          # typecheck + full suite
./scripts/docker-test.sh unit
./scripts/docker-test.sh integration
```

Equivalent one-liners without Compose:

```bash
docker build --target test -t helmcode/runner-core:test .
docker run --rm helmcode/runner-core:test
docker run --rm helmcode/runner-core:test npm run test:unit
```

| What runs | Details |
|-----------|---------|
| `npm run typecheck` | Strict TypeScript |
| `npm test` | 40+ unit + integration tests |
| Git fixtures | Created under container `/tmp` only |
| Network | Not required for the default suite |

Exit code is non-zero if any test fails (CI-friendly).

## 2. HTTP smoke (open-core API)

Starts the production image with an **in-container** local git fixture (bare remote + clone).  
Host port **18080** maps to container `8080`. No host repo mount needed.

```bash
./scripts/docker-test.sh smoke
# or
docker compose up --build -d smoke
```

Probe:

```bash
curl -s http://127.0.0.1:18080/health | jq

curl -s -X POST http://127.0.0.1:18080/v1/tasks/sync \
  -H 'content-type: application/json' \
  -d '{"prompt":"smoke","testCommand":"true"}' | jq
```

Async path:

```bash
curl -s -X POST http://127.0.0.1:18080/v1/tasks \
  -H 'content-type: application/json' \
  -d '{"id":"d1","prompt":"smoke","testCommand":"true"}' | jq

curl -s http://127.0.0.1:18080/v1/tasks/d1 | jq
```

Stop and remove containers/volumes:

```bash
./scripts/docker-test.sh smoke-down
# or
docker compose down -v
```

Notes:

- Default smoke uses a dummy `GITHUB_TOKEN` and a **local** bare remote (no GitHub).
- Fixture dirs are Docker volumes; init **clears contents only** (never removes mount points).
- Without `LLM_API_KEY`, the agent applies no file patches; `testCommand: "true"` still validates the full pipeline.
- To exercise a real LLM inside smoke:

  ```bash
  docker compose run --rm -e LLM_API_KEY -e LLM_BASE_URL -e LLM_MODEL -p 18080:8080 smoke
  ```

## 3. What stays off the host

| Host | Container |
|------|-----------|
| No `npm install` | `npm ci` inside image build |
| No global Node version pin | Node 22 bookworm |
| No temp git under `$TMPDIR` from suite | `/tmp` inside container |
| Optional: only port `18080` for smoke | Process + volumes isolated |

Build cache lives in Docker’s own storage (`docker builder prune` if you want to reclaim space).

## 4. CI

GitHub Actions workflow: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

- **test** — `npm ci` + typecheck + `npm test` on Node 22  
- **test-docker** — `docker compose run --rm --build test` (parity with local Docker-only path)

Triggered on `push` / `pull_request` to `main` (and `master`), plus `workflow_dispatch`.

## Targets reference

| Image target | Purpose |
|--------------|---------|
| `test` | Dev deps + source + tests |
| `runtime` | Production daemon |
| `smoke` | Runtime + fixture seed entrypoint |

See root `Dockerfile` and `compose.yaml`.
