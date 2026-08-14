# OpenCode ACP harness

Private notes for the **default** ACP Server behind the Agent Gateway.
**Not** a public HTTP API — clients use [`/v1/sessions/*`](./sessions.md).

```
Agent Gateway (ACP Client)
        │  stdio ndjson
        ▼
   opencode acp   ← AGENT_HARNESS=opencode
```

---

## Enable

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=opencode
AGENT_PROVIDER=opencode-go   # or opencode-zen → auth id `opencode`
AGENT_API_KEY=…
AGENT_DEFAULT_MODEL=opencode-go/glm-5.1
```

When sessions are on, runner installs `opencode-ai` (if missing) and spawns
`opencode acp`. Install paths, version, update interval, and ACP mode ids
are **code defaults** in
`services/runner/src/agent/harnesses/opencode/settings.ts`
(`OPENCODE_HARNESS_OVERLAY` for local overrides). Do not add `OPENCODE_*` env vars.

### Boot sequence

1. Write `$HOME/.local/share/opencode/auth.json` from `AGENT_PROVIDER` + `AGENT_API_KEY`
2. Ensure `$prefix/bin/opencode` (`npm install -g --prefix … opencode-ai@…`)
3. Spawn `opencode acp` with `HOME` pointing at OpenCode home
4. ACP `initialize` + keep connection for session RPCs
5. Optional periodic reinstall + restart (default 24h; overlay `updateIntervalHours: 0` to disable)

Needs **outbound network** to npm on first install. Persist `/app/.opencode` with a volume in Docker (`HOME=/app`). Local default prefix is `~/.helm/opencode`.

---

## Auth

- **LLM keys:** `AGENT_PROVIDER` + `AGENT_API_KEY` → OpenCode `auth.json`
- **Runner ingress:** `OPENCORE_API_TOKEN` Bearer (unrelated to OpenCode)

| `AGENT_PROVIDER` | auth.json id | model prefix |
|------------------|--------------|--------------|
| `opencode-go` | `opencode-go` | `opencode-go/…` |
| `opencode-zen` | `opencode` | `opencode/…` |

---

## Permissions

Headless policy lives in `services/runner/src/agent/settings.ts`
(`AGENT_SETTINGS_OVERLAY.permissionPolicy`, default `allow`).

---

## Health

`GET /v1/sessions/health` → `{ ok, provider: "acp", harness: "opencode", managed: {…} }`.

Code: `services/runner/src/agent/` + `harnesses/opencode/`.
