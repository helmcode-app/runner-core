# @helmcode/vfs (`helm-vfs`)

Go virtual filesystem process for HelmCode runner-core.

## Module

```
github.com/helmcode-app/runner-core/services/vfs
```

## Layout

```
services/vfs/
├── go.mod
├── cmd/helm-vfs/           # process entrypoint
└── internal/vfs/
    ├── protocol.go         # method names + DTOs (sync with runner protocol.ts)
    ├── rpc.go              # NDJSON JSON-RPC stream
    ├── server.go           # handler registry + dispatch
    ├── handlers.go         # initialize / read / write / shutdown
    ├── tree.go             # WalkDir scan
    ├── watcher.go          # fsnotify → didChange
    ├── paths.go            # safe relative paths
    ├── ignore.go           # ignored names
    ├── write.go            # atomic write
    └── project_name.go     # initialize.name resolution
```

## Build & test

From repo root:

```bash
npm run build:vfs
npm run test:go
```

```bash
cd services/vfs
go build -o bin/helm-vfs ./cmd/helm-vfs
go test ./...
./bin/helm-vfs --root /path/to/workspace
```

## Protocol

Newline-delimited JSON-RPC 2.0 on stdin/stdout. See [docs/api/vfs.md](../../docs/api/vfs.md).

Spawned by `@helmcode/runner` via `src/vfs` (`HELM_VFS_BIN`).
