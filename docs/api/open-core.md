# Open-core HTTP API

Standalone monolithic HTTP API for local / iPad clients.

| Item | Value |
|------|-------|
| Mode | `HELM_MODE=open-core` |
| Default bind | `0.0.0.0:8080` (`HOST` / `PORT`) |
| Content type | `application/json; charset=utf-8` |
| Auth | Optional Bearer (`OPENCORE_API_TOKEN`). When set, all routes **except** `GET /health` require `Authorization: Bearer <token>`. When unset, API is open (dev only). |
| Body size limit | 2 MiB |
| Implementation | `src/modes/open-core.ts` |

Shared schemas: [shared-types.md](./shared-types.md).

---

## Overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | no | Process liveness |
| `GET` | `/v1/status` | yes* | Runtime status |
| `POST` | `/v1/tasks` | yes* | Async task submit (`202`) |
| `GET` | `/v1/tasks/:id` | yes* | Poll task status, result, events |
| `POST` | `/v1/tasks/:id/cancel` | yes* | Cancel in-flight task |
| `POST` | `/v1/tasks/sync` | yes* | Synchronous task run (blocks until done) |

\* Required only when `OPENCORE_API_TOKEN` is configured. Missing/invalid token → `401 {"error":"unauthorized"}`.

Common response headers:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json; charset=utf-8` |
| `Cache-Control` | `no-store` |

---

## `GET /health`

Liveness probe. Returns immediately if the process is up.

### Request

| Item | Value |
|------|-------|
| Method | `GET` |
| Path | `/health` |
| Query | none |
| Headers | none required |
| Body | none |

### Response `200 OK`

Body type: [`HealthStatus`](./shared-types.md#healthstatus)

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Always `true` when the handler responds |
| `mode` | `"open-core" \| "commercial-saas"` | Current `HELM_MODE` |
| `version` | `string` | Service version |
| `uptimeMs` | `number` | Process uptime in milliseconds |
| `activeTasks` | `number` | Tasks currently executing in `AgentPipeline` |

```json
{
  "ok": true,
  "mode": "open-core",
  "version": "0.1.0",
  "uptimeMs": 12840,
  "activeTasks": 0
}
```

---

## `GET /v1/status`

Lightweight runtime snapshot for operators and clients.

### Request

| Item | Value |
|------|-------|
| Method | `GET` |
| Path | `/v1/status` |
| Query | none |
| Headers | none required |
| Body | none |

### Response `200 OK`

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `"open-core" \| "commercial-saas"` | Current `HELM_MODE` |
| `version` | `string` | Service version |
| `activeTasks` | `number` | In-flight agent runs |
| `knownTasks` | `number` | Size of the in-memory task map (includes completed tasks retained for polling) |

```json
{
  "mode": "open-core",
  "version": "0.1.0",
  "activeTasks": 1,
  "knownTasks": 3
}
```

### Notes vs `/health`

| Field | `/health` | `/v1/status` |
|-------|-----------|--------------|
| `ok` | yes | no |
| `uptimeMs` | yes | no |
| `knownTasks` | no | yes |

---

## `POST /v1/tasks`

Asynchronously submit an agent task. Returns immediately with a poll URL; the pipeline runs in the background.

### Request

| Item | Value |
|------|-------|
| Method | `POST` |
| Path | `/v1/tasks` |
| Query | none |
| Headers | `Content-Type: application/json` |
| Body | [`OpenCoreSubmitBody`](./shared-types.md#opencoresubmitbody) |

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | **yes** | Agent instruction (non-empty) |
| `id` | `string` | no | Task id; default UUID |
| `baseBranch` | `string` | no | Base branch |
| `testCommand` | `string` | no | Test command override |
| `contextPaths` | `string[]` | no | LLM context file paths |
| `timeoutMs` | `number` | no | Hard overall timeout (ms). Default: env `TASK_TIMEOUT_MS` (900000). `0` on env disables default. |
| `metadata` | `object` | no | Opaque metadata |

```json
{
  "prompt": "Fix the failing unit tests in the auth package",
  "id": "task-001",
  "baseBranch": "main",
  "testCommand": "go test ./...",
  "contextPaths": ["pkg/auth/login.go", "pkg/auth/login_test.go"],
  "metadata": { "source": "ipad", "ticket": "HC-42" }
}
```

### Responses

#### `202 Accepted`

Task accepted; pipeline started asynchronously.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Assigned task id |
| `status` | `"queued"` | Literal at acceptance time |
| `poll` | `string` | Relative poll path, `/v1/tasks/<id>` |

```json
{
  "id": "task-001",
  "status": "queued",
  "poll": "/v1/tasks/task-001",
  "cancel": "/v1/tasks/task-001/cancel"
}
```

#### `400 Bad Request`

```json
{ "error": "prompt is required" }
```

#### `409 Conflict`

```json
{ "error": "task task-001 already exists" }
```

#### `500 Internal Server Error`

```json
{ "error": "<message>" }
```

### Behavior

1. Validates `prompt`.
2. Resolves `id` (client or UUID).
3. Rejects duplicate `id` with `409`.
4. Starts `AgentPipeline.run` without awaiting completion.
5. Client polls `GET /v1/tasks/:id` for progress and final [`AgentResult`](./shared-types.md#agentresult).

Task records live **in process memory only**; they are lost on restart.

---

## `GET /v1/tasks/:id`

Poll task status, terminal result, and accumulated progress events.

### Request

| Item | Value |
|------|-------|
| Method | `GET` |
| Path | `/v1/tasks/:id` |
| Path param `id` | URL-encoded task id |
| Query | none |
| Headers | none required |
| Body | none |

### Response `200 OK`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Task id |
| `status` | `string` | `"running"` while in flight; otherwise terminal `AgentResult.status` (`succeeded` \| `failed` \| `cancelled`) |
| `result` | [`AgentResult`](./shared-types.md#agentresult) \| `null` | `null` until the run finishes |
| `events` | [`TaskProgressEvent[]`](./shared-types.md#taskprogressevent) | Ordered progress events collected so far |

**In flight:**

```json
{
  "id": "task-001",
  "status": "running",
  "result": null,
  "events": [
    {
      "taskId": "task-001",
      "status": "running",
      "message": "task accepted",
      "at": "2026-07-27T12:00:00.000Z",
      "detail": {
        "baseBranch": "main",
        "mainRepoPath": "/app/main_repo"
      }
    },
    {
      "taskId": "task-001",
      "status": "testing",
      "message": "test attempt 1/3",
      "at": "2026-07-27T12:00:45.120Z",
      "detail": {
        "testCommand": "go test ./..."
      }
    }
  ]
}
```

**Completed:**

```json
{
  "id": "task-001",
  "status": "succeeded",
  "result": {
    "taskId": "task-001",
    "status": "succeeded",
    "branch": "aero-agent/task-001",
    "worktreePath": "/app/workspaces/ws_task-001",
    "commitSha": "a1b2c3d4e5f6789012345678abcdef0123456789",
    "pushRemote": "origin",
    "testAttempts": [],
    "summary": "Branch aero-agent/task-001 pushed at a1b2c3d4e5f6789012345678abcdef0123456789",
    "startedAt": "2026-07-27T12:00:00.000Z",
    "finishedAt": "2026-07-27T12:01:12.400Z",
    "durationMs": 72400
  },
  "events": []
}
```

> Note: While the HTTP layer reports intermediate poll `status` as `"running"` until a terminal `result` exists, `events[].status` carries finer-grained pipeline states (`testing`, `healing`, `committing`, `pushing`, …).

### Response `404 Not Found`

```json
{ "error": "task not found" }
```

### Response `500 Internal Server Error`

```json
{ "error": "<message>" }
```

---

## `POST /v1/tasks/:id/cancel`

Request cooperative abort of an in-flight task. In-flight subprocesses (tests, git, LLM HTTP) are killed via `AbortSignal`. Worktree cleanup still runs.

### Request

| Item | Value |
|------|-------|
| Method | `POST` |
| Path | `/v1/tasks/:id/cancel` |
| Body | none |

### Responses

#### `202 Accepted`

```json
{
  "id": "task-001",
  "status": "cancelled",
  "message": "cancel signal sent"
}
```

Poll `GET /v1/tasks/:id` until `result.status === "cancelled"`.

#### `404 Not Found`

```json
{ "error": "task not found" }
```

#### `409 Conflict`

Task already finished or not cancellable.

```json
{ "error": "task already finished", "status": "succeeded" }
```

---

## `POST /v1/tasks/sync`

Synchronous convenience endpoint. Blocks until the agent pipeline finishes, then returns the full [`AgentResult`](./shared-types.md#agentresult).

Intended for simple clients and integration tests. Prefer `POST /v1/tasks` + poll for interactive UI.

### Request

| Item | Value |
|------|-------|
| Method | `POST` |
| Path | `/v1/tasks/sync` |
| Query | none |
| Headers | `Content-Type: application/json` |
| Body | [`OpenCoreSubmitBody`](./shared-types.md#opencoresubmitbody) (same as async submit) |

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | **yes** | Agent instruction |
| `id` | `string` | no | Task id; default UUID |
| `baseBranch` | `string` | no | Base branch |
| `testCommand` | `string` | no | Test command override |
| `contextPaths` | `string[]` | no | LLM context paths |
| `metadata` | `object` | no | Opaque metadata |

```json
{
  "prompt": "Add a README section about installation",
  "baseBranch": "main"
}
```

### Responses

#### `200 OK` / `409 Conflict` / `422 Unprocessable Entity`

| Status | `AgentResult.status` |
|--------|----------------------|
| `200` | `succeeded` |
| `409` | `cancelled` (client cancel or hard timeout) |
| `422` | `failed` |

Body is a full [`AgentResult`](./shared-types.md#agentresult).

```json
{
  "taskId": "3f2a9c1e-…",
  "status": "succeeded",
  "branch": "aero-agent/3f2a9c1e-…",
  "worktreePath": "/app/workspaces/ws_3f2a9c1e-…",
  "commitSha": "a1b2c3d4…",
  "pushRemote": "origin",
  "testAttempts": [],
  "summary": "Branch aero-agent/3f2a9c1e-… pushed at a1b2c3d4…",
  "startedAt": "2026-07-27T12:00:00.000Z",
  "finishedAt": "2026-07-27T12:01:12.400Z",
  "durationMs": 72400
}
```

#### `400 Bad Request`
```json
{ "error": "prompt is required" }
```

#### `500 Internal Server Error`

```json
{ "error": "<message>" }
```

### Behavior notes

- Unlike async submit, this path does **not** store the task in the pollable in-memory map for later `GET /v1/tasks/:id` (result is returned inline only).
- HTTP connection remains open for the full pipeline duration (worktree + LLM + tests + push). Clients should use generous timeouts.

---

## Pipeline summary (all task endpoints)

```
fetch main_repo
  → git worktree add -b aero-agent/<id> workspaces/ws_<id> origin/<baseBranch>
  → LLM file patches in worktree
  → self-healing tests (≤ MAX_TEST_RETRIES)
  → git commit + push (GITHUB_TOKEN)
  → git worktree remove
```

Required env for a successful end-to-end run:

- `MAIN_REPO_PATH` — local git checkout
- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` — OpenAI-compatible LLM
- `GITHUB_TOKEN` — push credentials

---

## Catch-all

Any unmatched method/path:

### `404 Not Found`

```json
{ "error": "not found" }
```
