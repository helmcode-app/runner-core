# Agent / ACP harness configuration

Client-facing selection for which ACP Server the runner spawns.
Sessions stay on [`/v1/sessions/*`](./sessions.md); harness catalog details:
[`harnesses.md`](./harnesses.md).

```
iPad ── PUT /v1/agent ──► runner persists agent.json ──► spawn / switch ACP
       GET  /v1/agent ──► catalog + phase + redacted key
```

Runner boots **without** ACP. Env `SESSIONS_ENABLED` / `AGENT_*` is only a
bootstrap when `$WORKSPACES_PATH/.setup/agent.json` is missing (CI / compose).

---

## Routes

Auth: device Bearer (same as other `/v1/*`).

| Method | Path | Description |
| -------- | ------ | ------------- |
| `GET` | `/v1/agent` | Current selection, phase, catalog |
| `PUT` | `/v1/agent` | Enable / disable / switch harness + key |
| `DELETE` | `/v1/agent` | Disable sessions (keeps last harness id) |

Persist file: `$WORKSPACES_PATH/.setup/agent.json` (mode `0600`).

---

## `GET /v1/agent`

```json
{
  "enabled": false,
  "harness": "claude",
  "hasApiKey": true,
  "apiKeyHint": "••••test",
  "source": "file",
  "phase": "disabled",
  "harnesses": [
    {
      "id": "opencode",
      "providers": "required",
      "impliedProvider": "opencode"
    },
    {
      "id": "claude",
      "providers": "unused",
      "impliedProvider": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  ]
}
```

| Field | Meaning |
| ------- | --------- |
| `enabled` | Whether ACP should be running |
| `phase` | `disabled` / `starting` / `ready` / `error` / `stopped` |
| `source` | `file` / `env` / `none` |
| `harnesses` | Catalog for the client picker |

API keys are never returned in full.

---

## `PUT /v1/agent`

```json
{
  "enabled": true,
  "harness": "codex",
  "apiKey": "sk-…",
  "defaultModel": "openai/gpt-5.2"
}
```

| Field | Notes |
| ------- | ------- |
| `enabled` | required boolean |
| `harness` | required: `opencode` / `claude` / `codex` / `cursor` / `grok` |
| `provider` | required when `harness=opencode` (`opencode-go` / `opencode-go-plus`) |
| `apiKey` | omit to keep previous; empty string clears |
| `defaultModel` | omit to keep; `null` clears |

**Switching harness** stops the current ACP process, writes the new selection,
then starts the new one when `enabled=true`. That Update path is also when
missing CLIs are installed (npm adapters, or Cursor’s official installer) —
cold boot never downloads a harness. Helm session JSON on disk is kept; ACP
sessions are rebuilt on the next prompt (same as runner restart).

| Response | When |
| ---------- | ------ |
| `200` | Applied (including `enabled=false`) |
| `400` | Validation error |
| `503` | Config saved but ACP failed to start (`phase=error`) |

---

## Status fields

`GET /v1/status` adds:

| Field | Meaning |
| ------- | --------- |
| `sessionsEnabled` | Gateway ready (`phase=ready`) |
| `agentConfigured` | `enabled=true` in selection |
| `agentPhase` | Same as `GET /v1/agent.phase` |
| `agentHarness` | Present when configured |
