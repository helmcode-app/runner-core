# Agent Sessions API

Stable HTTP/SSE surface for the iPad Commander. Runtime is an **ACP Client**
talking to a harness **ACP Server**. Default: OpenCode (`opencode acp`).
Other harnesses: [harnesses.md](./harnesses.md).

```
iPad  ── /v1/sessions/* ──►  runner Agent Gateway  ──ACP/stdio──►  opencode acp
```

- Public paths and JSON **never** name the vendor runtime.
- Gateway keeps Helm session ids, timeline, and SSE fan-out.
- Async prompts keep running if the iPad disconnects (ACP turn continues).

Design: [ACP-first runtime](../design/acp-first-runtime.md).

---

## Enable

**Managed OpenCode ACP** (local + cloud):

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=opencode
AGENT_PROVIDER=opencode-go
AGENT_API_KEY=oc-…
AGENT_DEFAULT_MODEL=opencode-go/glm-5.1
```

Harness install knobs are catalog defaults + overlays (`agent/harnesses/`).

HelmCode auth: `OPENCORE_API_TOKEN` Bearer (same as other `/v1/*` routes).

Details: [OpenCode](./opencode.md), [all harnesses](./harnesses.md).

---

## Routes

REST + SSE for the iPad. Method names follow ACP session verbs; the wire
format stays HTTP JSON (not ACP JSON-RPC).

| Method | Path | ACP | Description |
|--------|------|-----|-------------|
| `GET` | `/v1/sessions/health` | — | Runtime liveness (`provider: "acp"`) |
| `GET` | `/v1/sessions/models` | — | Catalog (`id` = `provider/model`) |
| `GET` | `/v1/sessions/events` | `session/update` | SSE of `SessionStreamEvent` |
| `POST` | `/v1/sessions` | `session/new` | Create → `{ session }` **201** |
| `GET` | `/v1/sessions` | — | List → `{ sessions }` |
| `GET` | `/v1/sessions/:id` | — | Get session |
| `DELETE` | `/v1/sessions/:id` | `session/close` | Delete |
| `POST` | `/v1/sessions/:id/prompt` | `session/prompt` | Async prompt **202** |
| `GET` | `/v1/sessions/:id/history` | — | Timeline for reconnect |
| `POST` | `/v1/sessions/:id/cancel` | `session/cancel` | Cancel in-flight turn |
| `POST` | `/v1/sessions/:id/rewind` | — (product) | Rewind to a user-message checkpoint |

ACP has no rewind. The gateway snapshots the git worktree before each prompt
and, on rewind, truncates the Helm timeline, restores files, and replaces the
ACP session (seeding the next prompt with prior turns).

```json
POST /v1/sessions/:id/rewind
{ "messageId": "user_<uuid>", "restore": "both" }
```

`restore` is `both` (default), `conversation`, or `code`. The selected user
message and everything after it are dropped. Response includes `prompt` (for
the composer), `truncated`, `filesRestored`, and the remaining `entries`.

File diffs / branch checkout stay on VFS (`vfs/gitDiff`, `vfs/gitCheckout`).

### Models (`GET /v1/sessions/models`)

Catalog comes from the harness ACP `configOptions` (OpenCode model selector),
plus `AGENT_DEFAULT_MODEL`. `?refresh=1` re-probes the harness.

```json
{
  "models": [
    { "id": "opencode-go/glm-5.1", "name": "glm-5.1", "provider": "opencode-go", "connected": true },
    { "id": "opencode-go/kimi-k2.6", "name": "kimi-k2.6", "provider": "opencode-go", "connected": true }
  ],
  "connected": ["opencode-go"],
  "defaultModel": "opencode-go/glm-5.1"
}
```

`AgentSession` may include `modes` (ACP ids advertised at `session/new`).

### Prompt (`POST /v1/sessions/:id/prompt`)

```json
{
  "prompt": "Fix the failing test",
  "model": "opencode-go/glm-5.1",
  "mode": "agent",
  "thinkLevel": "medium",
  "fast": false
}
```

| Field | Notes |
|-------|--------|
| `thinkLevel` | `low` / `medium` / `high` / `xhigh`. Mapped to ACP `session/set_config_option` (`thought_level`) when the harness advertises it; also sent on `_meta.helm`. |
| `fast` | Boolean. Mapped to a `fast` / `model_config` option when advertised; also sent on `_meta.helm`. |

### Usage (`GET /v1/sessions/:id/history`, `AgentSession.usage`)

ACP `usage_update` is stored on the session and returned as:

```json
{
  "usage": {
    "used": 53000,
    "size": 200000,
    "cost": { "amount": 0.045, "currency": "USD" }
  }
}
```

Live SSE event type is `session.usage` with the same payload.

### Create → prompt → events

`POST /v1/sessions` may include `workspaceId` (default `default`). The session
cwd, rewind snapshots, and `AgentSession.workspaceId` follow that workspace.

1. `POST /v1/sessions` → ACP `session/new` → Helm `{ session }` (**201**)
2. `POST …/prompt` → ACP `session/prompt` in background → **202**. The first user prompt becomes `session.title` when the current title is still a placeholder (`New chat`, empty, …). Later prompts do not rename it.
3. Live: `GET /v1/sessions/events` → Gateway SSE (`session.connected`, message/tool deltas, status, `session.updated`)
4. Reconnect: `GET …/history` then reopen events
5. Stop: `POST …/cancel` → ACP `session/cancel`

---

## Layout

| Path | Role |
|------|------|
| `src/sessions/` | Product HTTP/SSE |
| `src/sessions/title.ts` | Chat name from first user prompt |
| `src/agent/` | ACP client, gateway, permission / models |
| `src/agent/harnesses/create.ts` | `AGENT_HARNESS` → stdio supervisor |
| `src/agent/harnesses/catalog.ts` | Harness specs (provider policy, spawn, auth) |
| `src/agent/harnesses/stdio.ts` | Shared ACP process manager |
| `src/agent/harnesses/opencode/auth.ts` | OpenCode `auth.json` |
