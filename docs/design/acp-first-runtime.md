# Design: ACP-first agent runtime

Status: **implemented** — default ACP Server is **OpenCode** (`opencode acp`).  
Goose is a future optional harness, not a proxy: [acp-and-goose.md](./acp-and-goose.md).

---

## Roles

| Layer | Role |
| ------- | ------ |
| iPad / Commander | REST + SSE `/v1/sessions/*` |
| Runner | **ACP Client** + product gateway (ids, timeline, permissions) |
| Harness process | **ACP Server** — default `opencode acp` |

VFS / git / terminal stay runner siblings. Agents may later attach the same backends via MCP; they do not replace `/v1/vfs` or `/v1/terminal`.

```
iPad ── /v1/sessions/* ──► Agent Gateway (ACP Client)
                              │  stdio ndjson
                              ▼
                         harness ACP     ← /v1/agent harness=opencode|claude|codex|cursor|grok
                              │
                              ▼
                         LLM (OpenCode: provider + key; others: apiKey)

         /v1/workspaces → catalog (`default` = MAIN_REPO_PATH)
         /v1/vfs*?workspaceId=  → helm-vfs (one process per workspace)
         /v1/terminal?workspaceId= → in-process PTY
```

---

## Modules (`services/runner/src/agent/`)

| Path | Role |
| ------ | ------ |
| `gateway.ts` | Helm session registry, timeline, SSE, prompt 202, rewind |
| `checkpoint.ts` | git write-tree snapshot / read-tree restore |
| `rewind.ts` | Timeline truncate + seed-context planning |
| `persist.ts` | Durable Helm sessions (`$WORKSPACES_PATH/.sessions`) |
| `acp/connection.ts` | ACP initialize + permission + `session/update` |
| `map-updates.ts` | ACP updates → Helm timeline / SSE |
| `settings.ts` | Product overlays (permission, extra models, cwd) |
| `runtime-controller.ts` | Load/save agent.json; start / stop / switch harness |
| `config-store.ts` | Persisted agent selection |
| `routes.ts` | `GET/PUT/DELETE /v1/agent` |
| `harnesses/create.ts` | harness id → stdio supervisor |
| `harnesses/catalog.ts` | Specs: provider policy, spawn, auth kind |
| `harnesses/stdio.ts` | Shared install + `spawn` + ACP connect |
| `harnesses/stdio-settings.ts` | Install overlays (`OPENCODE_HARNESS_OVERLAY`, …) |
| `harnesses/opencode/auth.ts` | OpenCode `auth.json` only |
| `harnesses/types.ts` | `HarnessRuntime` contract |

`sessions/` is the public HTTP/SSE package only. It must not import harness internals.

Adding a harness = id in `ids.ts` + a `HARNESS_SPECS` row. Env-key CLIs need
no new process file. No new `/v1` routes.

---

## Configuration

Product path: client `PUT /v1/agent` → `$WORKSPACES_PATH/.setup/agent.json` →
`AgentRuntimeController` installs (if needed) and starts / switches the harness.
Runner boots with ACP off and **never** downloads a harness on cold start;
restart only resumes an already-installed binary when the file says enabled.

```bash
# Preferred (after device auth)
PUT /v1/agent  {"enabled":true,"harness":"claude","apiKey":"…"}

# Optional bootstrap when agent.json is missing
SESSIONS_ENABLED=true
AGENT_HARNESS=opencode
AGENT_PROVIDER=opencode-go
AGENT_API_KEY=…
AGENT_DEFAULT_MODEL=opencode-go/glm-5.1
```

| Source | Meaning |
| ----- | --------- |
| `/v1/agent` `harness` | Which ACP Server process to spawn |
| `/v1/agent` `provider` | LLM vendor **inside** OpenCode. Unused for single-vendor harnesses |
| `/v1/agent` `apiKey` | Key for that harness (stored in agent.json) |
| `/v1/agent` `defaultModel` | Default `provider/model` on prompt |

Install paths, version, update interval, ACP mode ids: `harnesses/catalog.ts`
plus overlays (`OPENCODE_HARNESS_OVERLAY`, `CLAUDE_HARNESS_OVERLAY`, …).
Permission / extra models / cwd: `agent/settings.ts` (`AGENT_SETTINGS_OVERLAY`).
Controller: `agent/runtime-controller.ts`.

---

## Session lifecycle

```
Create   POST /v1/sessions     → acp.session/new → Helm id + ACP id
Prompt   POST …/prompt         → 202; acp.session/prompt in background
Events   GET  …/events         → Gateway SSE from session/update
Cancel   POST …/cancel         → acp.session/cancel (notification)
Rewind   POST …/rewind         → Gateway checkpoint (not ACP)
History  GET  …/history        → Gateway timeline (product reconnect)
Restart  load JSON             → same Helm ids; ACP rebuilt on next prompt
Delete   DELETE …              → acp.session/close + unlink JSON
```

iPad stays on REST + SSE. Runner is the ACP Client; do not expose JSON-RPC
to the app. Branch checkout / file diffs stay on VFS. **Turn rewind** is a
Gateway product feature: snapshot the git tree before each prompt, then
truncate timeline + restore files + replace the ACP session.

---

## Decisions

| Topic | Choice |
| ------- | -------- |
| Agent abstraction | ACP (Runner = Client, harness = Server) |
| Default harness | **OpenCode ACP** (`opencode acp`) |
| Multi-harness bus | Direct ACP per harness — not Goose-in-the-middle |
| Goose / pi | Later multi-provider peers — need both `AGENT_HARNESS` and `AGENT_PROVIDER` |
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
