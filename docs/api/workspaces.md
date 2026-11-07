# Workspaces

Shared handle for the directory that **sessions, VFS, and terminal** operate on.

- `default` → `MAIN_REPO_PATH` (`kind: "primary"`) — first clone, or a host-mounted repo.
- Extra GitHub clones → `WORKSPACES_PATH/projects/<owner>--<repo>` (`kind: "project"`),
  registered in `WORKSPACES_PATH/.setup/workspaces.json`.
- Parallel task checkouts can still add `kind: "worktree"` later without changing these routes.

```
GET  /v1/workspaces
GET  /v1/workspaces/:id
```

```json
{
  "workspaces": [
    { "id": "default", "path": "/app/main_repo", "kind": "primary", "repo": { "owner": "acme", "repo": "app" } },
    { "id": "acme--api", "path": "/app/workspaces/projects/acme--api", "kind": "project", "repo": { "owner": "acme", "repo": "api" } }
  ],
  "defaultWorkspaceId": "default"
}
```

`POST /v1/setup/github/clone` fills `default` when `MAIN_REPO_PATH` is empty; otherwise it clones
into a new project workspace and returns `workspaceId` on the setup session payload.

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
to a project or worktree.
