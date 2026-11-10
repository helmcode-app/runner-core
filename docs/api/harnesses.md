# ACP harnesses

Private notes for the ACP Server behind the Agent Gateway.
Clients configure selection via [`/v1/agent`](./agent.md) and stay on
[`/v1/sessions/*`](./sessions.md) for chats.

## Product path (preferred)

```bash
# After device auth:
curl -X PUT "$RUNNER/v1/agent" \
  -H "authorization: Bearer …" \
  -H "content-type: application/json" \
  -d '{"enabled":true,"harness":"claude","apiKey":"sk-ant-…"}'
```

Persists to `$WORKSPACES_PATH/.setup/agent.json`. Switching `harness` stops the
old ACP process and starts the new one.

## Env bootstrap (optional)

Used only when `agent.json` is missing (CI / compose). Same fields as the PUT body:

| Kind | harness | provider | apiKey |
|------|---------|----------|--------|
| Multi-provider shell | `opencode` (later `pi` / `goose`) | **required** | key for that provider |
| Single-vendor product | `claude` / `codex` / `cursor` / `grok` | **unused** | key for that product |

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=opencode
AGENT_PROVIDER=opencode-go
AGENT_API_KEY=oc-…
AGENT_DEFAULT_MODEL=opencode-go/glm-5.1
```

Install / mode / binary knobs stay in code overlays, not env.

## Catalog

One supervisor (`harnesses/stdio.ts`) reads `HARNESS_SPECS`. OpenCode is not a
second process manager — it only writes `auth.json` before the same spawn path.

| harness id | Spawn | Auth | Models `provider` |
|------------|-------|------|-------------------|
| `opencode` | `opencode acp` (npm `opencode-ai`) | `auth.json` via `provider` | `opencode-go` (Go / Go Plus) |
| `claude` | `@agentclientprotocol/claude-agent-acp` | `ANTHROPIC_API_KEY` | `anthropic` |
| `codex` | `@agentclientprotocol/codex-acp` | `CODEX_API_KEY` (`OPENAI_API_KEY` fallback) | `openai` |
| `cursor` | `agent acp` (auto-install via `https://cursor.com/install`) | `CURSOR_API_KEY` | `cursor` |
| `grok` | `grok agent stdio` (PATH or `@xai-official/grok`) | `XAI_API_KEY` | `xai` |

Runner **does not** install anything on cold start. Enabling / switching via
`PUT /v1/agent` (app Update) **auto-installs** the ACP binary when missing:
Claude / Codex / Grok / OpenCode via npm into `~/.helm/<id>` (container:
`/app/.helm/<id>`; OpenCode uses `~/.helm/opencode` / `/app/.opencode`);
Cursor via the official curl installer into `~/.local/bin` (`agent` /
`cursor-agent`). Overlay `bin` still skips install. Restart only resumes an
already-installed binary.

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
