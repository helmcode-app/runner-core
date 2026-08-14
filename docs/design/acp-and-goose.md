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
2. Product features (Helm timeline, 202 prompt, reconnect history) live in the gateway, not in Goose.
3. VFS and terminal are iPad protocols; agents should reach the same backends via MCP if needed, not by replacing `/v1/vfs`.
4. Goose ACP+ / extensions are powerful but not portable across harnesses.

---

## How to add Goose later

Same catalog row as the other harnesses — not a rewrite and not a new supervisor:

1. Add `goose` to `agent/harnesses/ids.ts` (config enum follows)
2. Add a `HARNESS_SPECS` row (`goose acp`, `providers: "required"`)
3. Auth helper if Goose does not take a single env key (same idea as `opencode/auth.ts`)
4. Optional `GOOSE_HARNESS_OVERLAY` in `stdio-settings.ts`
5. Keep `/v1/sessions/*` and `AgentGateway` unchanged

Goose (and pi) are **multi-provider shells**, like OpenCode — both env vars matter:

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=goose          # instead of opencode
AGENT_PROVIDER=…             # which LLM that Goose install authenticates to
AGENT_API_KEY=…
```

Claude / Codex / Cursor / Grok do **not** need `AGENT_PROVIDER` — the harness is the vendor. See [harnesses.md](../api/harnesses.md).

Install knobs go in `harnesses/goose/settings.ts`, not a pile of `GOOSE_*` env vars.

---

## References

- [ACP v2 overview](https://agentclientprotocol.com/protocol/v2/overview)
- [goose ACP HTTP transport](https://github.com/block/goose/pull/6741)
- [goose Claude/Codex AcpProvider](https://github.com/block/goose/pull/6605)
- Implemented default: [opencode.md](../api/opencode.md)
