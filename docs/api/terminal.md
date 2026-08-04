# WebSSH Terminal API

Interactive shell over the **same host/port** as open-core (unified ingress).  
No SSH daemon and **no Docker socket** — the gateway spawns an **in-process PTY** (`node-pty`) inside the runner.

```
iPad / xterm.js  ==WSS==>  open-core /v1/terminal  ==PTY==>  bash/sh (runner process)
```

| Item | Value |
|------|-------|
| Node (production) | `services/runner/src/terminal/` (wired in open-core) |
| Go (optional sidecar) | `services/webssh/` (same local-PTY model) |
| iPad client | HelmCode app `Features/Editor/Terminal/` (xterm.js in WKWebView) |
| Auth | Same Bearer as open-core (`OPENCORE_API_TOKEN`); query `?token=` also accepted on Upgrade |

---

## Endpoints

| Path | Description |
|------|-------------|
| `WS /v1/terminal` | Preferred |
| `WS /api/v1/terminal/ws` | Alias for reverse-proxy layouts |

Query parameters (on the WebSocket URL):

| Param | Default | Description |
|-------|---------|-------------|
| `cols` | `80` | Initial columns |
| `rows` | `24` | Initial rows |
| `token` | — | Optional Bearer when `Authorization` cannot be set on Upgrade |

---

## Framing

| Direction | Frame | Payload |
|-----------|-------|---------|
| Client → server | **binary** | Raw PTY stdin bytes |
| Server → client | **binary** | Raw PTY stdout/stderr (TTY merged) |
| Client → server | **text JSON** | Control messages |
| Server → client | **text JSON** | Status / errors / pong |

### Control messages (client)

```json
{ "type": "resize", "cols": 80, "rows": 24 }
```

```json
{ "type": "ping", "t": 1710000000000 }
```

Optional (prefer binary for input):

```json
{ "type": "stdin", "data": "ls\n" }
```

### Control messages (server)

```json
{
  "type": "ready",
  "sessionId": "…",
  "backend": "local-pty",
  "shell": "/bin/bash -l",
  "cwd": "/app/main_repo"
}
```

```json
{ "type": "pong", "t": 1710000000000 }
```

```json
{ "type": "error", "message": "…" }
```

```json
{ "type": "exit", "status": 0 }
```

### Heartbeat

- WebSocket protocol **ping/pong** every `TERMINAL_HEARTBEAT_MS` (default 25s)
- App-level `{type:"ping"}` / `{type:"pong"}` for clients that only handle data frames

---

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `TERMINAL_ENABLED` | `false` | Enable gateway in open-core |
| `TERMINAL_SHELL` | `/bin/bash` | Shell (login `-l` added for bash/zsh when bare path) |
| `TERMINAL_WORKDIR` | `MAIN_REPO_PATH` | Shell cwd |
| `TERMINAL_MAX_SESSIONS` | `8` | Concurrent PTY sessions per process |
| `TERMINAL_HEARTBEAT_MS` | `25000` | Heartbeat interval; `0` disables |

### Color defaults (PTY env)

Interactive shells get:

| Variable | Value | Purpose |
|----------|--------|---------|
| `TERM` | `xterm-256color` | 256-color capable terminal |
| `COLORTERM` | `truecolor` | 24-bit color for modern CLIs |
| `CLICOLOR` / `CLICOLOR_FORCE` | `1` | BSD / macOS `ls` color |
| `FORCE_COLOR` | `1` | chalk / npm / many Node & Python tools |

GNU `ls` is aliased to `ls --color=auto` via the WebSSH interactive rc (see below).

### Interactive aliases (bash / zsh)

WebSSH sessions load a small Helm rc (`shell-init.ts` → temp `helm-terminal.rc`):

| Alias | Expansion |
|-------|-----------|
| `ls` | `ls --color=auto` (or BSD `ls -G`) |
| `ll` / `la` / `l` | long / almost-all / classify listings |
| `grep` / `egrep` / `fgrep` | `--color=auto` when supported |
| `..` `...` | `cd` up |
| `g` `gs` `gd` `ga` `gc` `gl` `gp` `gco` `gb` | common git shortcuts |
| `c` / `h` | `clear` / `history` |

The rc soft-sources `/etc/bash.bashrc` and `~/.bashrc` first so image/user customizations still apply.

### Requirements

1. Set `TERMINAL_ENABLED=true`
2. Image/host must include a shell (`bash` preferred; falls back to `sh`)
3. `node-pty` native module must build for the platform (Dockerfile already has `build-essential`)

No `docker.sock` mount. Works the same on macOS+Podman, bare metal, and Fly.io Machines.

### Security notes

- Shell runs as the **runner OS user** with that process's filesystem and network.
- Prefer `OPENCORE_API_TOKEN` on any non-local bind.
- Cap sessions with `TERMINAL_MAX_SESSIONS`; rely on container cgroup limits for CPU/RAM.

---

## Resize (iPad)

On orientation / keyboard / `visualViewport` changes, client should send:

```json
{ "type": "resize", "cols": <term.cols>, "rows": <term.rows> }
```

Server calls `pty.resize` so full-screen apps (`vim`, `htop`) reflow correctly.
