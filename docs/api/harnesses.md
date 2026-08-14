# ACP harnesses

Private notes for the ACP Server behind the Agent Gateway.
Clients stay on [`/v1/sessions/*`](./sessions.md).

## Env

| Kind | `AGENT_HARNESS` | `AGENT_PROVIDER` | `AGENT_API_KEY` |
|------|-----------------|------------------|-----------------|
| Multi-provider shell | `opencode` (later `pi` / `goose`) | **required** — which LLM | key for that provider |
| Single-vendor product | `claude` / `codex` / `cursor` / `grok` | **unused** | key for that product |

```bash
# OpenCode (default) — two axes
AGENT_HARNESS=opencode
AGENT_PROVIDER=opencode-go
AGENT_API_KEY=oc-…
AGENT_DEFAULT_MODEL=opencode-go/glm-5.1

# Claude / Codex / Cursor / Grok — harness is the vendor
AGENT_HARNESS=claude
AGENT_API_KEY=sk-ant-…
AGENT_DEFAULT_MODEL=anthropic/claude-sonnet-4-6
```

Install / mode / binary knobs stay in code overlays, not env.

## Catalog

One supervisor (`harnesses/stdio.ts`) reads `HARNESS_SPECS`. OpenCode is not a
second process manager — it only writes `auth.json` before the same spawn path.

| `AGENT_HARNESS` | Spawn | Auth | Models `provider` |
|-----------------|-------|------|-------------------|
| `opencode` | `opencode acp` (npm `opencode-ai`) | `auth.json` via `AGENT_PROVIDER` | `opencode-go` / `opencode` |
| `claude` | `@agentclientprotocol/claude-agent-acp` | `ANTHROPIC_API_KEY` | `anthropic` |
| `codex` | `@agentclientprotocol/codex-acp` | `CODEX_API_KEY` (`OPENAI_API_KEY` fallback) | `openai` |
| `cursor` | `agent acp` (Cursor CLI on PATH) | `CURSOR_API_KEY` | `cursor` |
| `grok` | `grok agent stdio` (PATH or `@xai-official/grok`) | `XAI_API_KEY` | `xai` |

Cursor is PATH-only (`agent` / `cursor-agent`, or overlay `bin`).
Claude / Codex / Grok install into `~/.helm/<id>` (container: `/app/.helm/<id>`).
OpenCode install prefix is `~/.helm/opencode` locally and `/app/.opencode` in
the container (compose.dev volume `dev-opencode`).

Overlays: `services/runner/src/agent/harnesses/stdio-settings.ts`
(`OPENCODE_HARNESS_OVERLAY`, `CLAUDE_HARNESS_OVERLAY`, `CODEX_HARNESS_OVERLAY`,
`CURSOR_HARNESS_OVERLAY`, `GROK_HARNESS_OVERLAY`).

Set `requireApiKey: false` to reuse a local `claude` / `agent login` / `grok login`.

OpenCode details: [opencode.md](./opencode.md).

## Adding another harness

Env-key ACP servers (most CLIs) are catalog-only:

1. Add the id to `agent/harnesses/ids.ts`
2. Add a `HARNESS_SPECS` row (`auth: "env"`, `providers: "unused"`)
3. Optional overlay constant in `stdio-settings.ts`

Multi-provider shells (pi / goose) also need `providers: "required"` and a
small auth helper, same pattern as `opencode/auth.ts`.

`/v1/sessions` and the Agent Gateway do not change. There is no per-vendor
`process.ts` and no factory `switch`.
