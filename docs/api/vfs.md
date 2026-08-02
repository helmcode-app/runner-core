# VFS protocol (JSON-RPC over stdio / WebSocket)

The Go binary `helm-vfs` (`services/vfs`) exposes a virtual filesystem over the active workspace root.  
Node.js `services/runner/src/vfs` spawns the binary and multiplexes newline-delimited JSON-RPC.

**Method name constants** (keep in sync):

- Go: `services/vfs/internal/vfs/protocol.go`
- Node: `services/runner/src/vfs/protocol.ts`

## Transport

| Layer | Channel |
|-------|---------|
| Go process | stdin requests · stdout responses + notifications · stderr logs |
| open-core WebSocket | `ws://host:port/v1/vfs` (Bearer auth when configured) |
| open-core HTTP fallback | `POST /v1/vfs/rpc` |
| Status | `GET /v1/vfs/status` |

## Module layout

### Go (`services/vfs`)

```
cmd/helm-vfs/main.go
internal/vfs/
  protocol.go    # method names, DTOs, change types
  rpc.go         # NDJSON stream + ReadLoop
  server.go      # dispatch via handler registry
  handlers.go    # initialize / read / write / shutdown
  tree.go        # WalkDir scan
  watcher.go     # fsnotify → didChange
  paths.go       # safe path join
  ignore.go      # .git / node_modules
  write.go       # atomic write
  project_name.go
```

### Node (`services/runner/src/vfs`)

```
protocol.ts       # method names + wire types
bridge.ts         # spawn helm-vfs, RPC multiplex
resolveBinary.ts  # HELM_VFS_BIN resolution
http.ts           # POST /v1/vfs/rpc, GET /v1/vfs/status
gateway.ts        # WebSocket /v1/vfs
index.ts          # public exports
```

## Methods

### `vfs/initialize`

**Request**

```json
{"jsonrpc":"2.0","id":1,"method":"vfs/initialize","params":{"root":"/app/main_repo"}}
```

**Result**

```json
{
  "root": "/app/main_repo",
  "name": "my-repo",
  "remote": "github.com/org/my-repo",
  "branch": "feature/vfs",
  "entries": [
    { "path": "pkg", "size": 0, "type": "dir" },
    { "path": "pkg/a.go", "size": 12, "type": "file" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `root` | Absolute workspace path (internal; Docker may use `/app/main_repo`) |
| `name` | Client label: `VFS_PROJECT_NAME` / `PROJECT_NAME` → git origin repo name → basename |
| `remote` | Git `origin` display form (`github.com/org/repo`); empty if no origin — clients must not use `root` as UI remote |
| `branch` | Current HEAD branch (`git symbolic-ref --short HEAD`); empty if detached / not a git repo — clients must not invent `main` |
| `entries` | Flattened tree via `filepath.WalkDir`; skips `.git`, `node_modules` |

### `vfs/read` (small files only)

Legacy convenience for files ≤ **256 KiB**. Implemented with `os.Open` + `ReadAt` (not `os.ReadFile`). Larger files return `-32602` and must use `vfs/read_chunk`.

```json
{"jsonrpc":"2.0","id":2,"method":"vfs/read","params":{"path":"pkg/a.go"}}
```

```json
{"jsonrpc":"2.0","id":2,"result":{"path":"pkg/a.go","content":"package pkg\n","size":12}}
```

### `vfs/read_chunk` (preferred)

Bounded segment via `file.ReadAt`. Default limit **65536** bytes; max **262144**.

```json
{"jsonrpc":"2.0","id":2,"method":"vfs/read_chunk","params":{"path":"pkg/a.go","offset":0,"limit":65536}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "path": "pkg/a.go",
    "content": "…",
    "offset": 0,
    "bytes_read": 65536,
    "is_eof": false,
    "file_size": 200000
  }
}
```

Client loop: start `offset=0`; append `content`; if `!is_eof` then `offset += bytes_read` and request again.

### `vfs/write`
```json
{"jsonrpc":"2.0","id":3,"method":"vfs/write","params":{"path":"pkg/a.go","content":"package pkg\n"}}
```

Atomic write via temp file + rename.

### `vfs/didChange` (server → client notification)

```json
{"jsonrpc":"2.0","method":"vfs/didChange","params":{"path":"pkg/a.go","type":"write"}}
```

`type`: `write` | `create` | `remove` | `rename`  
Source: native `fsnotify` (inotify on Linux).

### `vfs/shutdown`

```json
{"jsonrpc":"2.0","id":9,"method":"vfs/shutdown","params":{}}
```

## Path safety

All client paths must be relative to the workspace root. Absolute paths and `..` escapes are rejected.

## Environment

| Variable | Description |
|----------|-------------|
| `VFS_ENABLED` | `true`/`false` — start helm-vfs from open-core (default true) |
| `HELM_VFS_BIN` | Path to binary (default auto: `services/vfs/bin/helm-vfs` or `/app/bin/helm-vfs`) |
| `VFS_ROOT` / `MAIN_REPO_PATH` | Default root for helm-vfs |
| `VFS_PROJECT_NAME` / `PROJECT_NAME` | Override `initialize.name` |
