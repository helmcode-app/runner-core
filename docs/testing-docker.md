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
docker run --rm helmcode/runner-core:test npm run test:unit -w @helmcode/runner
```

| What runs | Details |
|-----------|---------|
| `npm run typecheck -w @helmcode/runner` | Strict TypeScript |
| `npm test -w @helmcode/runner` | Unit + integration (builds helm-vfs in image) |
| Git fixtures | Created under container `/tmp` only |
| Network | Not required for the default suite |

Exit code is non-zero if any test fails (CI-friendly).

## 2. Dev with a host repository (iPad / VFS)

Bind-mount a host git checkout into `MAIN_REPO_PATH` (`/app/main_repo`) using [`compose.dev.yaml`](../compose.dev.yaml):

```bash
export HOST_REPO=/absolute/path/to/your/git/repo   # must contain .git
docker compose -f compose.yaml -f compose.dev.yaml up --build dev
```

| Item | Value |
|------|--------|
| Host port | `18080` → container `8080` (override with `DEV_PORT`) |
| Repo mount | `$HOST_REPO` → `/app/main_repo` |
| Workspaces | Docker volume `dev-workspaces` → `/app/workspaces` |
| VFS | `VFS_ENABLED=true` (same process spawns `helm-vfs`) |

If `HOST_REPO` is empty or not a git repo, smoke-init seeds a **fixture** into the mount (avoid that for real projects — point at a real `.git` tree).

```bash
curl -s http://127.0.0.1:18080/health | jq .
curl -s http://127.0.0.1:18080/v1/vfs/status | jq .
```

Stop:

```bash
docker compose -f compose.yaml -f compose.dev.yaml down
```

## 3. HTTP smoke (open-core API)

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
curl -s http://127.0.0.1:18080/v1/status | jq
curl -s http://127.0.0.1:18080/v1/vfs/status | jq
```

Agent sessions (optional — needs network for the managed harness install):

```bash
docker compose run --rm \
  -e SESSIONS_ENABLED=true \
  -e AGENT_HARNESS=opencode \
  -e AGENT_API_KEY=oc-… \
  -p 18080:8080 smoke

curl -s http://127.0.0.1:18080/v1/sessions/health | jq
```

Stop and remove containers/volumes:

```bash
./scripts/docker-test.sh smoke-down
# or
docker compose down -v
```

Notes:

- Smoke seeds a **local** bare remote + clone (no GitHub).
- Fixture dirs are Docker volumes; init **clears contents only** (never removes mount points).
- Default smoke does **not** enable sessions; health/VFS still exercise the daemon.

## 4. What stays off the host

| Host | Container |
|------|-----------|
| No `npm install` | `npm ci` inside image build |
| No global Node version pin | Node 22 bookworm |
| No temp git under `$TMPDIR` from suite | `/tmp` inside container |
| Optional: only port `18080` for smoke | Process + volumes isolated |

Build cache lives in Docker’s own storage (`docker builder prune` if you want to reclaim space).

## 5. CI

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
