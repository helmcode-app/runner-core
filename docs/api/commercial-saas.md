# Commercial SaaS JSON-RPC API

Headless elastic worker controlled by an external commercial gateway.  
The worker does **not** expose a public client HTTP port; it only opens **outbound** HTTP connections to `GATEWAY_URL`.

| Item | Value |
|------|-------|
| Mode | `HELM_MODE=commercial-saas` |
| Transport | HTTP `POST` JSON-RPC 2.0 to `GATEWAY_URL` |
| Direction | Worker → Gateway (all methods) |
| Auth | Optional `Authorization: Bearer <GATEWAY_TOKEN>` |
| Identity header | `X-Helm-Worker: <WORKER_ID or anonymous>` |
| Poll interval | `POLL_INTERVAL_MS` (default `2000`) |
| Implementation | `src/modes/commercial-saas.ts` |

Shared schemas: [shared-types.md](./shared-types.md).

---

## Transport envelope

Every call is a JSON-RPC 2.0 request:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "<method>",
  "params": { }
}
```

Success:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "result": { }
}
```

Error:

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "error": {
    "code": -32000,
    "message": "human readable",
    "data": null
  }
}
```

Request headers sent by the worker:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `Accept` | `application/json` |
| `Authorization` | `Bearer <GATEWAY_TOKEN>` when configured |
| `X-Helm-Worker` | Worker id or `anonymous` |

RPC timeout: **30s** per call (worker-side abort).

---

## Methods (worker → gateway)

| Method | When | Purpose |
|--------|------|---------|
| `worker.register` | Boot | Announce worker + capabilities |
| `worker.heartbeat` | Every poll loop | Liveness + load |
| `worker.deregister` | Shutdown | Graceful leave |
| `task.lease` | When idle | Claim next work item |
| `task.progress` | When buffer non-empty | Flush progress events |
| `task.complete` | After agent run | Report terminal result |

---

## `worker.register`

### Params

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worker_id` | `string` | yes | Unique worker instance id (`WORKER_ID` or generated `worker-<8hex>`) |
| `version` | `string` | yes | runner-core version |
| `capabilities` | `string[]` | yes | Fixed: `["git-worktree", "self-healing-tests", "push"]` |

```json
{
  "jsonrpc": "2.0",
  "id": "…",
  "method": "worker.register",
  "params": {
    "worker_id": "worker-a1b2c3d4",
    "version": "0.1.0",
    "capabilities": ["git-worktree", "self-healing-tests", "push"]
  }
}
```

### Result

Gateway-defined. Worker currently ignores the result payload (any JSON value / `null` is accepted).

Recommended gateway response:

```json
{ "ok": true }
```

---

## `worker.heartbeat`

### Params

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worker_id` | `string` | yes | Worker id |
| `active_tasks` | `number` | yes | Current in-flight agent runs |
| `lease_id` | `string` | no | Present while a leased task is held |

```json
{
  "method": "worker.heartbeat",
  "params": {
    "worker_id": "worker-a1b2c3d4",
    "active_tasks": 1,
    "lease_id": "lease-99"
  }
}
```

### Result

Gateway-defined (ignored by worker). Recommended: `{ "ok": true }`.

---

## `worker.deregister`

### Params

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worker_id` | `string` | yes | Worker id |

```json
{
  "method": "worker.deregister",
  "params": {
    "worker_id": "worker-a1b2c3d4"
  }
}
```

### Result

Gateway-defined (ignored). Failures are logged; process still exits.

---

## `task.lease`

Pull the next unit of work when the worker is idle (`activeTaskCount === 0`).

### Params

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worker_id` | `string` | yes | Worker id |

```json
{
  "method": "task.lease",
  "params": {
    "worker_id": "worker-a1b2c3d4"
  }
}
```

### Result

One of:

1. **No work** — `null` or object without `task`
2. **Lease granted**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | [`AgentTask`](./shared-types.md#agenttask) | yes (when work available) | Task payload |
| `github_token` | `string` | no | Per-lease push/fetch token (overrides env) |
| `lease_id` | `string` | no | Lease correlation id for heartbeat/complete |

```json
{
  "jsonrpc": "2.0",
  "id": "…",
  "result": {
    "lease_id": "lease-99",
    "github_token": "ghs_…",
    "task": {
      "id": "task-001",
      "prompt": "Fix failing CI tests",
      "baseBranch": "main",
      "testCommand": "go test ./...",
      "contextPaths": ["pkg/auth/login.go"],
      "metadata": { "org": "acme" }
    }
  }
}
```

If `task.id` is empty, the worker assigns a UUID.

---

## `task.progress`

Flush buffered [`TaskProgressEvent`](./shared-types.md#taskprogressevent) items (max buffer 500 events).

### Params

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worker_id` | `string` | yes | Worker id |
| `events` | `TaskProgressEvent[]` | yes | Ordered batch since last flush |

```json
{
  "method": "task.progress",
  "params": {
    "worker_id": "worker-a1b2c3d4",
    "events": [
      {
        "taskId": "task-001",
        "status": "testing",
        "message": "test attempt 1/3",
        "at": "2026-07-27T12:00:45.120Z",
        "detail": { "testCommand": "go test ./..." }
      }
    ]
  }
}
```

### Result

Gateway-defined (ignored). Recommended: `{ "ok": true, "accepted": <n> }`.

---

## `task.complete`

Report terminal pipeline outcome after `AgentPipeline.run` finishes (success or failure).

### Params

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `worker_id` | `string` | yes | Worker id |
| `lease_id` | `string` | no | Lease id from `task.lease` (if any) |
| `result` | [`AgentResult`](./shared-types.md#agentresult) | yes | Full terminal result |

```json
{
  "method": "task.complete",
  "params": {
    "worker_id": "worker-a1b2c3d4",
    "lease_id": "lease-99",
    "result": {
      "taskId": "task-001",
      "status": "succeeded",
      "branch": "aero-agent/task-001",
      "worktreePath": "/app/workspaces/ws_task-001",
      "commitSha": "a1b2c3d4…",
      "pushRemote": "origin",
      "testAttempts": [],
      "summary": "Branch aero-agent/task-001 pushed at a1b2c3d4…",
      "startedAt": "2026-07-27T12:00:00.000Z",
      "finishedAt": "2026-07-27T12:01:12.400Z",
      "durationMs": 72400
    }
  }
}
```

### Result

Gateway-defined (ignored). Recommended: `{ "ok": true }`.

After `task.complete`, the worker clears its current lease and becomes eligible for the next `task.lease`.

---

## Worker loop (reference)

```
register
loop every POLL_INTERVAL_MS:
  flush task.progress (if any)
  worker.heartbeat
  if idle:
    lease = task.lease
    if lease.task:
      result = AgentPipeline.run(task)
      task.complete(result)
on SIGTERM/SIGINT:
  worker.deregister
  exit
```

---

## Required environment

| Variable | Required | Description |
|----------|----------|-------------|
| `HELM_MODE` | yes | Must be `commercial-saas` |
| `GATEWAY_URL` | yes | Gateway JSON-RPC HTTP endpoint |
| `GATEWAY_TOKEN` | no | Bearer token |
| `WORKER_ID` | no | Stable worker identity |
| `POLL_INTERVAL_MS` | no | Loop interval (default `2000`) |
| `MAIN_REPO_PATH` | yes (for runs) | Shared git checkout |
| `LLM_*` | yes (for runs) | LLM credentials |
| `GITHUB_TOKEN` | no | Fallback if lease omits `github_token` |

---

## Gateway implementation notes

The gateway is **out of scope** for this repository. To interoperate:

1. Accept JSON-RPC 2.0 POST at `GATEWAY_URL`.
2. Implement the six methods above.
3. Return `result: null` (or `{}` without `task`) from `task.lease` when the queue is empty.
4. Treat `task.complete` as the source of truth for billing / PR creation / client notification.
