# Workspaces

Shared handle for the directory that **sessions, VFS, and terminal** operate on.

Today there is one workspace: `default` → `MAIN_REPO_PATH` (`kind: "primary"`).
Later parallel tasks add `kind: "worktree"` entries under `WORKSPACES_PATH`
without changing these routes.

```
GET  /v1/workspaces
GET  /v1/workspaces/:id
```

```json
{
  "workspaces": [
    { "id": "default", "path": "/app/main_repo", "kind": "primary" }
  ],
  "defaultWorkspaceId": "default"
}
```

## Binding

Omit `workspaceId` anywhere below → `default`.

| Surface | How to bind |
|---------|-------------|
| Session | `POST /v1/sessions` body `{ "workspaceId": "default" }` |
| VFS WS | `ws://…/v1/vfs?workspaceId=default` |
| VFS HTTP | `GET /v1/vfs/status?workspaceId=` · `POST /v1/vfs/rpc?workspaceId=` |
| Terminal | `ws://…/v1/terminal?workspaceId=default&cols=&rows=` |

Each workspace gets its own helm-vfs process (watcher + root). Agent rewind
snapshots that workspace path, not the primary repo, when the session is bound
to a worktree.
