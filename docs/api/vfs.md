# VFS protocol (JSON-RPC over stdio / WebSocket)

The Go binary `helm-vfs` (`services/vfs`) exposes a virtual filesystem over the active workspace root.  
Node.js `services/runner/src/vfs` spawns the binary and multiplexes newline-delimited JSON-RPC.

**Method name constants** (keep in sync):

- Go core: `services/vfs/internal/vfs/protocol.go`
- Go git: `services/vfs/internal/vfs/git_protocol.go`
- Node core: `services/runner/src/vfs/protocol.ts`
- Node git: `services/runner/src/vfs/protocol-git.ts`

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
  protocol.go       # core method names + DTOs
  git_protocol.go   # git method names + DTOs
  rpc.go            # NDJSON stream + ReadLoop
  server.go         # dispatch via handler registry
  handlers.go       # initialize / read / write / shutdown
  handlers_git.go   # gitStatus / gitRefs / gitDiff / gitShow / gitCheckout
  git.go            # shared git exec helpers
  git_status.go     # porcelain v2 status
  git_refs.go       # branches + tags
  git_diff.go       # unified diff + git show
  git_checkout.go   # switch / track / detach
  tree.go           # WalkDir scan
  watcher.go        # fsnotify → didChange
  paths.go          # safe path join
  ignore.go         # .git / node_modules
  write.go          # atomic write
  project_name.go   # name / remote / branch identity
```

### Node (`services/runner/src/vfs`)

```
protocol.ts       # core method names + wire types (+ re-exports git)
protocol-git.ts   # git method names + wire types
bridge.ts         # spawn helm-vfs, RPC multiplex + typed git helpers
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

### `vfs/gitStatus` (read-only)

Working-tree status for the Source Control sidebar. No commit / push / stage.

```json
{"jsonrpc":"2.0","id":10,"method":"vfs/gitStatus","params":{}}
```

```json
{
  "isRepo": true,
  "branch": "feature/x",
  "upstream": "origin/feature/x",
  "ahead": 1,
  "behind": 0,
  "changes": [
    { "path": "src/a.go", "status": "modified", "staged": false },
    { "path": "new.txt", "status": "untracked", "staged": false },
    { "path": "renamed.txt", "status": "renamed", "staged": true, "fromPath": "old.txt" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `isRepo` | `false` when root is not a git work tree (other fields empty) |
| `branch` | Current HEAD branch; empty when detached |
| `upstream` | Tracking ref from `@{upstream}` when set — never invented |
| `ahead` / `behind` | Only present when upstream tracking exists |
| `changes[].status` | `added` \| `modified` \| `deleted` \| `untracked` \| `renamed` |
| `changes[].staged` | Index-side change (`XY` first char ≠ `.` in porcelain v2) |

Impl: `git status --porcelain=v2 -b`. Diff bodies are **not** included — use `vfs/gitDiff`.

### `vfs/gitRefs` (read-only)

```json
{"jsonrpc":"2.0","id":11,"method":"vfs/gitRefs","params":{}}
```

```json
{
  "isRepo": true,
  "localBranches": [
    { "name": "main", "tip": "a1b2c3d", "isCurrent": true },
    { "name": "develop", "tip": "e4f5a6b" }
  ],
  "remoteBranches": [
    { "name": "origin/main", "tip": "a1b2c3d" }
  ],
  "tags": [
    { "name": "v0.1.0", "tip": "a1b2c3d" }
  ]
}
```

Impl: `git for-each-ref` on `refs/heads`, `refs/remotes`, `refs/tags` (annotated tags peeled to commit).

### `vfs/gitDiff` (read-only)

Unified diff for one workspace-relative path. Caps at **256 KiB** (`truncated: true` when cut).

```json
{"jsonrpc":"2.0","id":12,"method":"vfs/gitDiff","params":{"path":"src/a.go","staged":false}}
```

```json
{
  "path": "src/a.go",
  "staged": false,
  "diff": "diff --git a/src/a.go b/src/a.go\n@@ -1,3 +1,4 @@\n…"
}
```

| Params | Description |
|--------|-------------|
| `path` | Relative to workspace root (same safety rules as `vfs/read`) |
| `staged` | `true` → `git diff --cached`; default unstaged worktree diff |

Untracked files use `git diff --no-index /dev/null <path>` when the worktree diff is empty.

### `vfs/gitShow` (read-only)

File contents at a revision (for CodeMirror merge / original side). Default revision is `HEAD`. Missing path → `exists: false` (not an error). Caps at **256 KiB**.

```json
{"jsonrpc":"2.0","id":13,"method":"vfs/gitShow","params":{"path":"src/a.go","revision":"HEAD"}}
```

```json
{
  "path": "src/a.go",
  "revision": "HEAD",
  "exists": true,
  "content": "package main\n"
}
```

### `vfs/gitCheckout`

Switch HEAD to a local branch, remote-tracking branch, or tag.

```json
{"jsonrpc":"2.0","id":14,"method":"vfs/gitCheckout","params":{"ref":"develop","kind":"localBranch"}}
```

| `kind` | Behavior |
|--------|----------|
| `localBranch` | `git switch -- <ref>` |
| `remoteBranch` | If local name exists → switch to it; else `git switch -c <local> --track <ref>` (`origin/foo/bar` → local `foo/bar`) |
| `tag` | `git switch --detach -- <ref>` |

```json
{
  "ref": "develop",
  "kind": "localBranch",
  "branch": "develop",
  "detached": false
}
```

Dirty worktree / conflicts surface as RPC `-32603` with git’s message. Clients should refresh tree + `gitStatus` / `gitRefs` after success.

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
