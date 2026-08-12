# Agent Sessions API

Stable, **backend-agnostic** HTTP/SSE surface for the iPad Commander.

```
iPad  ── /v1/sessions/* ──►  runner open-core  ──►  session runtime adapter
                                                      (OpenCode Server today)
```

- Public paths and JSON **never** name the vendor runtime.
- Sessions persist in the runtime; async prompts keep running if the iPad disconnects.
- Swap adapters later without changing iPad contracts.

---

## Enable

**Managed** (local + cloud — API key, no host auth mount):

```bash
OPENCODE_ENABLED=true
OPENCODE_MANAGED=true
OPENCODE_API_KEY=oc-…                 # dashboard key
OPENCODE_AUTH_PROVIDER=opencode
OPENCODE_DEFAULT_MODEL=opencode/big-pickle
OPENCODE_VERSION=latest
OPENCODE_PREFIX=/app/.opencode
```

**External** (you run serve yourself with your own auth):

```bash
opencode serve --hostname 127.0.0.1 --port 4096

OPENCODE_ENABLED=true
OPENCODE_MANAGED=false
OPENCODE_BASE_URL=http://127.0.0.1:4096
```

HelmCode auth: `OPENCORE_API_TOKEN` Bearer (same as other `/v1/*` routes).

Details: [OpenCode adapter](./opencode.md).

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/sessions/health` | Runtime liveness |
| `GET` | `/v1/sessions/models` | Models for **connected** providers (`id` = `provider/model`) |
| `GET` | `/v1/sessions/events` | SSE stream of `SessionStreamEvent` |
| `POST` | `/v1/sessions` | Create session → `{ session }` |
| `GET` | `/v1/sessions` | List → `{ sessions: AgentSession[] }` |
| `GET` | `/v1/sessions/:id` | Get session |
| `DELETE` | `/v1/sessions/:id` | Delete session |
| `POST` | `/v1/sessions/:id/prompt` | Async prompt (**202** `PromptAccepted`) |
| `GET` | `/v1/sessions/:id/history` | Timeline for offline rebuild |
| `POST` | `/v1/sessions/:id/abort` | Cancel in-flight work |
| `POST` | `/v1/sessions/:id/revert` | Roll back to a message (`{ "messageId": "msg_…" }`) |
| `POST` | `/v1/sessions/:id/unrevert` | Undo the last revert |
| `GET` | `/v1/sessions/:id/diff` | File diffs for a turn (`?messageId=`) |

### Checkpoint restore (Cursor-like rollback)

OpenCode message-level revert undoes file changes and chat after a given message.

```http
POST /v1/sessions/:id/revert
Content-Type: application/json

{ "messageId": "msg_…" }
```

```json
{ "sessionId": "ses_…", "reverted": true, "session": { "id": "…", "status": "idle" } }
```

Undo once with:

```http
POST /v1/sessions/:id/unrevert
```

```json
{ "sessionId": "ses_…", "unreverted": true, "session": { "id": "…", "status": "idle" } }
```

iPad UX: long-press / “Restore checkpoint” on a chat bubble → confirm → reload history; header shows “Undo restore” while `canUnrevert` is live.

---

## DTOs (Helm)

### `AgentSession`

```json
{
  "id": "ses_…",
  "title": "optional",
  "status": "idle|running|completed|failed|cancelled|unknown",
  "createdAt": "ISO-8601?",
  "updatedAt": "ISO-8601?",
  "backend": "session-runtime"
}
```

### Prompt body

```json
{
  "prompt": "Refactor auth middleware",
  "model": "anthropic/claude-sonnet-4-20250514",
  "mode": "agent",
  "contextPaths": ["pkg/auth/middleware.go"]
}
```

| `mode` | Meaning |
|--------|---------|
| `agent` | Full autonomous / file-changing pipeline |
| `plan` | Read-only plan |
| `ask` | Q&A |

### Prompt accepted (202)

```json
{
  "sessionId": "ses_…",
  "status": "accepted",
  "mode": "agent",
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

### History

```json
{
  "sessionId": "ses_…",
  "session": { "id": "…", "status": "…" },
  "entries": [
    {
      "id": "msg_…",
      "at": "…",
      "kind": "message",
      "role": "user",
      "text": "…"
    }
  ]
}
```

### SSE `SessionStreamEvent`

```json
{
  "type": "session.connected|session.event|…",
  "at": "ISO-8601",
  "sessionId": "optional",
  "data": {}
}
```

---

## Offline recovery

1. `GET /v1/sessions/:id/history?limit=200`
2. Open `GET /v1/sessions/events` for live updates
3. Continue with `POST /v1/sessions/:id/prompt` on the same id

---

## Layout

| Package | Role |
|---------|------|
| `src/sessions/` | Public `/v1/sessions/*` + Helm DTOs |
| `sessions/routes.ts` | HTTP handlers |
| `sessions/mapper.ts` | Wire → session + timeline |
| `sessions/map-tools.ts` | Tool/patch → `ToolAction` rows |
| `sessions/map-tool-content.ts` | Extract path / diff body from tool parts |
| `sessions/models.ts` | Connected provider model catalog |
| `sessions/sse.ts` | Event stream proxy |
| `src/opencode/` | Private OpenCode adapter |
| `opencode/client.ts` | Session/message API surface |
| `opencode/transport.ts` | HTTP transport |
| `opencode/runtime.ts` | Managed install + serve |
| `opencode/binary.ts` | Binary path / package helpers |
