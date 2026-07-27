# Shared types

Reusable schemas referenced by both the open-core HTTP API and the commercial-saas JSON-RPC contract.  
Canonical TypeScript definitions live in `src/types.ts`.

---

## Enums

### `HelmMode`

```ts
type HelmMode = "open-core" | "commercial-saas";
```

### `TaskStatus`

Lifecycle states emitted in progress events and poll responses.

```ts
type TaskStatus =
  | "queued"
  | "running"
  | "testing"
  | "healing"
  | "committing"
  | "pushing"
  | "succeeded"
  | "failed"
  | "cancelled";
```

| Status | Meaning |
|--------|---------|
| `queued` | Accepted by the control plane / HTTP layer; not yet running |
| `running` | Worktree setup or LLM patch in progress |
| `testing` | Local test command executing |
| `healing` | Test failed; LLM corrective patch applied before retry |
| `committing` | Tests green; creating git commit |
| `pushing` | Pushing branch to remote |
| `succeeded` | Terminal success |
| `failed` | Terminal failure |
| `cancelled` | Terminal cancellation (reserved) |

---

## `OpenCoreSubmitBody`

Request body for task submission endpoints.

```ts
interface OpenCoreSubmitBody {
  prompt: string;
  id?: string;
  baseBranch?: string;
  testCommand?: string;
  contextPaths?: string[];
  metadata?: Record<string, unknown>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | `string` | **yes** | Natural-language or structured instruction for the agent. Must be non-empty after trim. |
| `id` | `string` | no | Client-supplied task id. If omitted, server generates a UUID. Used in branch name `aero-agent/<id>` and worktree `ws_<id>`. |
| `baseBranch` | `string` | no | Git base branch. Default: env `DEFAULT_BASE_BRANCH` (`main`). |
| `testCommand` | `string` | no | Shell test command override. If omitted, auto-detected from repo markers (`go.mod`, `Cargo.toml`, `package.json`, …). |
| `contextPaths` | `string[]` | no | Relative file paths loaded into the LLM context. |
| `metadata` | `object` | no | Opaque client metadata (not interpreted by the engine). |

---

## `AgentTask`

Full task object used by the agent pipeline and commercial-saas leases.

```ts
interface AgentTask {
  id: string;
  prompt: string;
  baseBranch?: string;
  testCommand?: string;
  repoPath?: string;
  githubToken?: string;
  remote?: string;
  contextPaths?: string[];
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Stable task identifier. |
| `prompt` | `string` | **yes** | Agent instruction. |
| `baseBranch` | `string` | no | Base branch (default env). |
| `testCommand` | `string` | no | Test command override. |
| `repoPath` | `string` | no | Absolute path override for the shared main repo (default `MAIN_REPO_PATH`). |
| `githubToken` | `string` | no | Per-task GitHub token for fetch/push (else `GITHUB_TOKEN`). |
| `remote` | `string` | no | Git remote name (default `origin`). |
| `contextPaths` | `string[]` | no | Relative paths for LLM context. |
| `timeoutMs` | `number` | no | Soft wall-clock budget for test runs (ms). |
| `metadata` | `object` | no | Opaque metadata. |

---

## `CommandResult`

```ts
interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string` | Display string of the executed command |
| `cwd` | `string` | Working directory |
| `exitCode` | `number` | Process exit code (`0` = success) |
| `stdout` | `string` | Captured stdout (may be truncated) |
| `stderr` | `string` | Captured stderr (may be truncated) |
| `durationMs` | `number` | Wall time in milliseconds |

---

## `TestAttempt`

One iteration of the self-healing test loop.

```ts
interface TestAttempt {
  attempt: number;
  result: CommandResult;
  healed: boolean;
}
```

| Field | Type | Description |
|-------|------|-------------|
| `attempt` | `number` | 1-based attempt index |
| `result` | `CommandResult` | Test command outcome |
| `healed` | `boolean` | `true` if a corrective LLM patch was applied after this failure before retrying |

---

## `AgentResult`

Terminal result of a completed agent run.

```ts
interface AgentResult {
  taskId: string;
  status: "succeeded" | "failed" | "cancelled";
  branch: string;
  worktreePath: string;
  commitSha?: string;
  pushRemote?: string;
  testAttempts: TestAttempt[];
  summary: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | `string` | yes | Task id |
| `status` | `"succeeded" \| "failed" \| "cancelled"` | yes | Terminal status |
| `branch` | `string` | yes | Agent branch, e.g. `aero-agent/<taskId>` |
| `worktreePath` | `string` | yes | Worktree path used during the run (may be removed after completion) |
| `commitSha` | `string` | no | Git commit SHA when a commit was created |
| `pushRemote` | `string` | no | Remote name used for push (on success) |
| `testAttempts` | `TestAttempt[]` | yes | Ordered test / heal attempts |
| `summary` | `string` | yes | Human-readable summary |
| `error` | `string` | no | Error message when `status` is `failed` |
| `startedAt` | `string` | yes | ISO-8601 start timestamp |
| `finishedAt` | `string` | yes | ISO-8601 finish timestamp |
| `durationMs` | `number` | yes | Total duration in milliseconds |

**Success example:**

```json
{
  "taskId": "task-001",
  "status": "succeeded",
  "branch": "aero-agent/task-001",
  "worktreePath": "/app/workspaces/ws_task-001",
  "commitSha": "a1b2c3d4e5f6789012345678abcdef0123456789",
  "pushRemote": "origin",
  "testAttempts": [
    {
      "attempt": 1,
      "result": {
        "command": "go test ./...",
        "cwd": "/app/workspaces/ws_task-001",
        "exitCode": 0,
        "stdout": "ok\n",
        "stderr": "",
        "durationMs": 1842
      },
      "healed": false
    }
  ],
  "summary": "Branch aero-agent/task-001 pushed at a1b2c3d4e5f6789012345678abcdef0123456789",
  "startedAt": "2026-07-27T12:00:00.000Z",
  "finishedAt": "2026-07-27T12:01:12.400Z",
  "durationMs": 72400
}
```

**Failure example:**

```json
{
  "taskId": "task-002",
  "status": "failed",
  "branch": "aero-agent/task-002",
  "worktreePath": "/app/workspaces/ws_task-002",
  "testAttempts": [
    {
      "attempt": 3,
      "result": {
        "command": "go test ./...",
        "cwd": "/app/workspaces/ws_task-002",
        "exitCode": 1,
        "stdout": "",
        "stderr": "--- FAIL: TestLogin ...",
        "durationMs": 900
      },
      "healed": false
    }
  ],
  "summary": "task failed",
  "error": "tests still failing after 3 attempt(s)\nlast exit 1: --- FAIL: TestLogin ...",
  "startedAt": "2026-07-27T12:05:00.000Z",
  "finishedAt": "2026-07-27T12:08:30.000Z",
  "durationMs": 210000
}
```

---

## `TaskProgressEvent`

Streaming / polled progress notification.

```ts
interface TaskProgressEvent {
  taskId: string;
  status: TaskStatus;
  message: string;
  at: string;
  detail?: Record<string, unknown>;
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskId` | `string` | yes | Task id |
| `status` | `TaskStatus` | yes | Current lifecycle status |
| `message` | `string` | yes | Human-readable progress line |
| `at` | `string` | yes | ISO-8601 event timestamp |
| `detail` | `object` | no | Structured extras (`branch`, `commitSha`, `testCommand`, …) |

**Example:**

```json
{
  "taskId": "task-001",
  "status": "testing",
  "message": "test attempt 1/3",
  "at": "2026-07-27T12:00:45.120Z",
  "detail": {
    "testCommand": "go test ./..."
  }
}
```

---

## `HealthStatus`

```ts
interface HealthStatus {
  ok: true;
  mode: HelmMode;
  version: string;
  uptimeMs: number;
  activeTasks: number;
}
```

---

## Error body (HTTP)

Generic error envelope used by open-core JSON responses.

```ts
interface ErrorBody {
  error: string;
}
```

| HTTP status | Typical `error` |
|-------------|-----------------|
| `400` | `prompt is required` |
| `404` | `task not found` / `not found` |
| `409` | `task <id> already exists` |
| `500` | Unhandled exception message |

---

## JSON-RPC 2.0 envelopes

Used by commercial-saas (worker → gateway).

### Request

```ts
interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}
```

### Success response

```ts
interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
}
```

### Error response

```ts
interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}
```
