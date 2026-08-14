# Design: ACP-first agent runtime

Status: **implemented** — default ACP Server is **OpenCode** (`opencode acp`).  
Goose is a future optional harness, not a proxy: [acp-and-goose.md](./acp-and-goose.md).

---

## Roles

| Layer | Role |
|-------|------|
| iPad / Commander | REST + SSE `/v1/sessions/*` |
| Runner | **ACP Client** + product gateway (ids, timeline, permissions) |
| Harness process | **ACP Server** — default `opencode acp` |

VFS / git / terminal stay runner siblings. Agents may later attach the same backends via MCP; they do not replace `/v1/vfs` or `/v1/terminal`.

```
iPad ── /v1/sessions/* ──► Agent Gateway (ACP Client)
                              │  stdio ndjson
                              ▼
                         opencode acp     ← AGENT_HARNESS=opencode (default)
                              │
                              ▼
                         LLM (AGENT_PROVIDER + AGENT_API_KEY)

         /v1/vfs*  → helm-vfs
         /v1/terminal → in-process PTY
```

---

## Modules (`services/runner/src/agent/`)

| Path | Role |
|------|------|
| `gateway.ts` | Helm session registry, timeline, SSE, prompt 202 |
| `acp/connection.ts` | ACP initialize + permission + `session/update` |
| `map-updates.ts` | ACP updates → Helm timeline / SSE |
| `settings.ts` | Product overlays (permission, extra models, cwd) |
| `harnesses/create.ts` | `AGENT_HARNESS` → runtime factory |
| `harnesses/types.ts` | `HarnessRuntime` contract |
| `harnesses/opencode/` | Default harness: auth.json, install, `opencode acp` |

`sessions/` is the public HTTP/SSE package only. It must not import harness internals.

Adding a harness = new `harnesses/<name>/` + a `switch` arm in `create.ts`. No new `/v1` routes.

---

## Configuration

Env is selection + secrets only:

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=opencode          # default ACP Server
AGENT_PROVIDER=opencode-go      # LLM vendor for that harness
AGENT_API_KEY=…
AGENT_DEFAULT_MODEL=opencode-go/glm-5.1
```

| Env | Meaning |
|-----|---------|
| `AGENT_HARNESS` | Which ACP Server process to spawn |
| `AGENT_PROVIDER` | Which LLM that process authenticates to |
| `AGENT_API_KEY` | Key for `AGENT_PROVIDER` |
| `AGENT_DEFAULT_MODEL` | Default `provider/model` on prompt |

Install paths, version, update interval, ACP mode ids: `harnesses/opencode/settings.ts` (`OPENCODE_HARNESS_OVERLAY`).  
Permission / extra models / cwd: `agent/settings.ts` (`AGENT_SETTINGS_OVERLAY`).

---

## Session lifecycle

```
Create   POST /v1/sessions     → acp.session/new → Helm id + ACP id
Prompt   POST …/prompt         → 202; acp.session/prompt in background
Events   GET  …/events         → Gateway SSE from session/update
Cancel   POST …/abort          → acp.session/cancel (notification)
History  GET  …/history        → Gateway timeline
Delete   DELETE …              → acp.session/close
```

Revert / diff are product git checkpoints (not ACP). Routes return **501** until that lands.

---

## Decisions

| Topic | Choice |
|-------|--------|
| Agent abstraction | ACP (Runner = Client, harness = Server) |
| Default harness | **OpenCode ACP** (`opencode acp`) |
| Multi-harness bus | Direct ACP per harness — not Goose-in-the-middle |
| Goose | Later `AGENT_HARNESS=goose` (optional peer) |
| Product API | Keep `/v1/sessions/*` |
| VFS / terminal | Runner siblings; optional MCP later |
| OpenCode HTTP (`opencode serve`) | Removed |

---

## References

- [ACP architecture](https://agentclientprotocol.com/get-started/architecture)
- [ACP v2 overview](https://agentclientprotocol.com/protocol/v2/overview)
- Product API: [sessions.md](../api/sessions.md)
- OpenCode harness: [opencode.md](../api/opencode.md)
- Goose (later): [acp-and-goose.md](./acp-and-goose.md)
