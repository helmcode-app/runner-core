# Agent Sessions API

Stable HTTP/SSE surface for the iPad Commander. Runtime is an **ACP Client**
talking to a harness **ACP Server**. Default: OpenCode (`opencode acp`).

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

Harness install knobs are code defaults (`agent/harnesses/opencode/settings.ts`).

HelmCode auth: `OPENCORE_API_TOKEN` Bearer (same as other `/v1/*` routes).

Details: [OpenCode ACP harness](./opencode.md).

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/sessions/health` | Runtime liveness (`provider: "acp"`) |
| `GET` | `/v1/sessions/models` | Configured models (`id` = `provider/model`) |
| `GET` | `/v1/sessions/events` | SSE stream of `SessionStreamEvent` |
| `POST` | `/v1/sessions` | Create session → `{ session }` |
| `GET` | `/v1/sessions` | List → `{ sessions: AgentSession[] }` |
| `GET` | `/v1/sessions/:id` | Get session |
| `DELETE` | `/v1/sessions/:id` | Delete session |
| `POST` | `/v1/sessions/:id/prompt` | Async prompt (**202** `PromptAccepted`) |
| `GET` | `/v1/sessions/:id/history` | Timeline for offline rebuild |
| `POST` | `/v1/sessions/:id/abort` | Cancel in-flight work |
| `POST` | `/v1/sessions/:id/revert` | **501** until git checkpoints land |
| `POST` | `/v1/sessions/:id/unrevert` | **501** until git checkpoints land |
| `GET` | `/v1/sessions/:id/diff` | Empty list for now (git diffs planned) |

### Create → prompt → events

1. `POST /v1/sessions` → ACP `session/new` → Helm `{ session }` (**201**)
2. `POST …/prompt` → ACP `session/prompt` in background → **202**
3. Live: `GET /v1/sessions/events` → Gateway SSE (`session.connected`, message/tool deltas, status)
4. Reconnect: `GET …/history` then reopen events

---

## Layout

| Path | Role |
|------|------|
| `src/sessions/` | Product HTTP/SSE |
| `src/agent/` | ACP client, gateway, permission / models |
| `src/agent/harnesses/create.ts` | `AGENT_HARNESS` → runtime |
| `src/agent/harnesses/opencode/` | Default ACP Server (`opencode acp`) |
