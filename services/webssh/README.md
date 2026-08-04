# helm-webssh (optional Go sidecar)

Standalone WebSSH gateway using an **in-process PTY** (no `docker.sock`, no sshd).

Production monorepo path prefers the Node gateway inside open-core:

`services/runner/src/terminal/` → open-core `/v1/terminal`

## Build

```bash
cd services/webssh
go build -o bin/helm-webssh .
```

## Run

```bash
export TERMINAL_WORKDIR=/path/to/repo
export OPENCORE_API_TOKEN=optional
export TERMINAL_SHELL=/bin/bash
export TERMINAL_MAX_SESSIONS=8
./bin/helm-webssh
# HTTP_ADDR=:8081
```

Paths: `/v1/terminal`, `/api/v1/terminal/ws`, `/health`.

## Protocol

Same as [docs/api/terminal.md](../../docs/api/terminal.md): binary PTY frames + JSON `resize` / `ping`.
