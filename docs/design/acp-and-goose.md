# Goose as a future ACP harness

Status: **not implemented**. Default ACP Server is **OpenCode** (`AGENT_HARNESS=opencode`).  
Architecture: [ACP-first runtime](./acp-first-runtime.md).

---

## What this is (and is not)

Goose can speak ACP (`goose acp` / goose-acp HTTP) and can also *front* other agents (Claude Code, Codex) as an ACP client.

That does **not** make Goose the runner’s bus.

| Idea | Verdict |
|------|---------|
| Default ACP Server | **OpenCode** (`opencode acp`) |
| Goose as proxy in front of OpenCode | **No** — extra hop, no gain |
| Goose as another `AGENT_HARNESS` later | **Yes, optional** |
| Fold VFS / git / terminal into Goose | **No** — keep runner siblings |

```
# Today (default)
/v1/sessions → Agent Gateway → opencode acp

# Later (optional peer, same gateway)
/v1/sessions → Agent Gateway → goose acp
```

Do not insert Goose between runner and OpenCode.

---

## Why OpenCode stays the default

1. OpenCode already is a first-class ACP Server (`opencode acp`). Runner talks to it directly.
2. Product features (Helm timeline, 202 prompt, revert/diff) live in the gateway, not in Goose.
3. VFS and terminal are iPad protocols; agents should reach the same backends via MCP if needed, not by replacing `/v1/vfs`.
4. Goose ACP+ / extensions are powerful but not portable across harnesses.

---

## How to add Goose later

Same pattern as OpenCode — a peer harness, not a rewrite:

1. `services/runner/src/agent/harnesses/goose/` (settings overlay, spawn `goose acp`, auth/env)
2. One arm in `harnesses/create.ts` for `AGENT_HARNESS=goose`
3. Extend `config.ts` `AGENT_HARNESS` enum
4. Keep `/v1/sessions/*` and `AgentGateway` unchanged

Env stays:

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=goose          # instead of opencode
AGENT_PROVIDER=…             # whatever that Goose install authenticates to
AGENT_API_KEY=…
```

Install knobs go in `harnesses/goose/settings.ts`, not a pile of `GOOSE_*` env vars.

---

## References

- [ACP v2 overview](https://agentclientprotocol.com/protocol/v2/overview)
- [goose ACP HTTP transport](https://github.com/block/goose/pull/6741)
- [goose Claude/Codex AcpProvider](https://github.com/block/goose/pull/6605)
- Implemented default: [opencode.md](../api/opencode.md)
