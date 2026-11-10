# OpenCode ACP harness

Private notes for the **default** ACP Server behind the Agent Gateway.
**Not** a public HTTP API — clients use [`/v1/sessions/*`](./sessions.md).

```
Agent Gateway (ACP Client)
        │  stdio ndjson
        ▼
   opencode acp   ← AGENT_HARNESS=opencode
```

OpenCode uses the same stdio supervisor as Claude / Codex / Cursor / Grok.
The only OpenCode-specific step is writing `auth.json`. See
[harnesses.md](./harnesses.md).

---

## Enable

```bash
SESSIONS_ENABLED=true
AGENT_HARNESS=opencode
AGENT_API_KEY=…
AGENT_DEFAULT_MODEL=opencode/beam-free   # or opencode-go/…
```

OpenCode needs `AGENT_HARNESS=opencode` + `AGENT_API_KEY`. `AGENT_PROVIDER`
defaults to `opencode-go` (legacy aliases `opencode` / `opencode-go-plus` /
`opencode-zen` still normalize). Free Zen models (`opencode/*`) work on the
same Go connection. Claude / Codex / Cursor / Grok only need the harness + key.

When the app enables OpenCode (`PUT /v1/agent`), runner installs `opencode-ai`
(if missing) and spawns `opencode acp`. Cold start does not install. Install
paths, version, update interval, and ACP mode ids are **catalog defaults** in
`services/runner/src/agent/harnesses/catalog.ts`. Local overrides:
`OPENCODE_HARNESS_OVERLAY` in
`services/runner/src/agent/harnesses/stdio-settings.ts`.
Do not add `OPENCODE_*` env vars.

### Enable sequence (app Update)

1. Write `$HOME/.local/share/opencode/auth.json` from `provider` + `apiKey`
2. Ensure `$prefix/bin/opencode` (`npm install -g --prefix … opencode-ai@…`)
3. Spawn `opencode acp` with `HOME` pointing at OpenCode home
4. ACP `initialize` + keep connection for session RPCs
5. Optional periodic reinstall + restart (default 24h; overlay `updateIntervalHours: 0` to disable)

Needs **outbound network** to npm on first enable. Persist `/app/.opencode` with a volume in Docker (`HOME=/app`). Local default prefix is `~/.helm/opencode`.

---

## Auth

- **LLM keys:** `AGENT_API_KEY` → OpenCode `auth.json` (`opencode-go` slot; provider defaults)
- **Runner ingress:** device Bearer (unrelated to OpenCode)

| auth.json id | model prefix |
|--------------|--------------|
| `opencode-go` | `opencode-go/…` and free `opencode/…` |

---

## Permissions

Headless policy lives in `services/runner/src/agent/settings.ts`
(`AGENT_SETTINGS_OVERLAY.permissionPolicy`, default `allow`).

---

## Health

`GET /v1/sessions/health` → `{ ok, provider: "acp", harness: "opencode", managed: {…} }`.

Code: `services/runner/src/agent/harnesses/` (`catalog.ts`, `stdio.ts`, `opencode/auth.ts`).
