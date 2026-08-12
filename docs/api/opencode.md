# OpenCode adapter (internal)

Public API: **[Agent Sessions](./sessions.md)** (`/v1/sessions/*`).

This document only describes the **optional** local OpenCode process used as the
current session-runtime adapter. Clients must not depend on OpenCode paths or payloads.

## Two modes

| Mode | When | Who starts `opencode serve` |
|------|------|-------------------------------|
| **Managed** (recommended in container) | `OPENCODE_ENABLED=true` + `OPENCODE_MANAGED=true` | Runner: install at **process boot**, then spawn serve |
| **External** | `OPENCODE_ENABLED=true` + `OPENCODE_MANAGED=false` | You: run serve separately |

### Managed (boot install + API key + periodic update)

Local and production use the **same** secret — no host `auth.json` mount.

```bash
OPENCODE_ENABLED=true
OPENCODE_MANAGED=true
# At least one. Go-only subscription → set only OPENCODE_GO_API_KEY.
OPENCODE_GO_API_KEY=oc-…           # → auth opencode-go / models opencode-go/*
OPENCODE_ZEN_API_KEY=              # → auth opencode / models opencode/*
OPENCODE_DEFAULT_MODEL=opencode-go/glm-5.1
OPENCODE_VERSION=latest
OPENCODE_PREFIX=/app/.opencode
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_UPDATE_INTERVAL_HOURS=24  # 0 = install once at boot only
```

Boot sequence:

1. Write `$OPENCODE_HOME/.local/share/opencode/auth.json` from  
   `OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY` (only non-empty slots)
2. If `$OPENCODE_PREFIX/bin/opencode` is missing →  
   `npm install -g --prefix $OPENCODE_PREFIX opencode-ai@$OPENCODE_VERSION`
3. `opencode serve` with `HOME` set so it reads that auth
4. Wait for `GET /global/health`
5. Expose Helm `/v1/sessions/*`
6. Every `OPENCODE_UPDATE_INTERVAL_HOURS` hours (if &gt; 0): reinstall + restart serve

The Docker image does **not** pre-install OpenCode. First managed boot needs
**outbound network** to npm. Persist `OPENCODE_PREFIX` with a volume. Inject
Go/Zen keys via env / Secret only.

`GET /v1/sessions/models` only lists providers you configured (even if OpenCode
marks both catalogs as connected for the same account key).

### External (manual serve)

```bash
opencode serve --hostname 127.0.0.1 --port 4096

OPENCODE_ENABLED=true
OPENCODE_MANAGED=false
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_DEFAULT_MODEL=anthropic/claude-sonnet-4-20250514
```

Upstream OpenCode HTTP reference: https://opencode.ai/docs/server/

## Auth

- **Client → runner:** `OPENCORE_API_TOKEN` Bearer (same as other `/v1/*`).
- **Runner → OpenCode HTTP:** optional Basic via `OPENCODE_SERVER_PASSWORD` /
  `OPENCODE_SERVER_USERNAME` (serve gate only — **not** the model API key).
- **OpenCode → models:** `OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY` written
  to `auth.json` as `opencode-go` / `opencode` before `opencode serve` starts.
  Same for local `.env` and cloud Secrets.

## Mapping (adapter → Helm)

| Helm | OpenCode (today) |
|------|------------------|
| `POST /v1/sessions` | `POST /session` |
| `POST …/prompt` | `POST /session/:id/prompt_async` |
| `GET …/history` | `GET /session/:id/message` → `TimelineEntry[]` |
| `POST …/abort` | `POST /session/:id/abort` |
| `GET /v1/sessions/events` | `GET /global/event` → `SessionStreamEvent` |
| `mode=agent\|plan\|ask` | `agent` field + system preamble |

`GET /v1/sessions/health` may include a `managed` object when
`OPENCODE_MANAGED=true` (state, version, prefix binary path).

Code: `services/runner/src/opencode/` (client + runtime) +
`services/runner/src/sessions/mapper.ts`.
