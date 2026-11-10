# Runner setup (open-core)

Device auth. There is no shared Bearer.

```
runner start  →  stderr: Helm setup code: SDCN-9XZS   (only when no devices)
iPad          →  Add runner → URL + code + device name
              →  POST /v1/setup/enroll  →  this device's token (Keychain)
              →  Runner page → GitHub + clone, or open the repo already on disk
```

The code is eight characters, `XXXX-XXXX`, from an unambiguous alphabet. It is not an API token. Bootstrap / invite codes expire in 10 minutes and are single-use.

`HOST_REPO` only skips GitHub clone. Pairing still requires a setup code.

### Review / demo code (optional)

Set `REVIEW_SETUP_CODE=ABCD-EFGH` for App Review or a public demo runner. That code:

- Does **not** expire
- Is **reusable** (each enroll still gets its own device Bearer)
- Completes immediately (no second-device approval)
- Should stay unset in production

## Three ways in

| Situation | Who mints the code | What the new device does |
| --------- | ------------------ | ------------------------ |
| No devices yet | Runner process, or `setup:enroll` | Enroll completes immediately |
| Another device exists | That device, `POST /v1/setup/invites` | Enroll stays pending until the first device allows it |
| Every device is gone | `setup:recover` on the machine | Revokes all tokens immediately, then same as first enroll |
| `REVIEW_SETUP_CODE` set | Operator via env | Enroll with that fixed code anytime |

Network requests cannot mint a bootstrap or recovery code.

```bash
docker compose -f compose.yaml -f compose.dev.yaml exec dev \
  node dist/entrypoint.js setup:enroll
docker compose -f compose.yaml -f compose.dev.yaml exec dev \
  node dist/entrypoint.js setup:recover
```

`docker exec` runs as root. These commands drop to the workspace owner before writing, so the running `helm` process can read the new code.

`setup:browser` prints a code for the setup page only. It does not pair a device and does not unlock VFS, terminal, or sessions.

## Auth

- Each device gets its own random token. The runner stores a hash.
- `Authorization: Bearer` is that device token.
- WebSocket upgrades accept the same Bearer, or a single-use `?ticket=` from `POST /v1/setup/ws-tickets` (60 seconds). `?token=` is ignored.
- Unauthenticated `GET /v1/setup` returns only `{ paired, authRequired }`.
- Deleting a project on one iPad does not revoke the token. Revoke it from another device, or run `setup:recover`.
- The last device cannot be revoked from the API. Use `setup:recover`.
- An empty token does not mean open access.

## Routes

| Method | Path | Auth | Notes |
| -------- | ------ | ------ | -------- |
| `GET` | `/` | no | Setup page. Does not pair a device. |
| `GET` | `/v1/setup` | no | `{ paired, authRequired }` |
| `POST` | `/v1/setup/enroll` | code | `{ code, deviceName }` → `complete` or `pending` |
| `GET` | `/v1/setup/enrollments/:id` | enrollment id | Poll. Token is returned once. |
| `POST` | `/v1/setup/browser` | setup or browser code | Operator cookie for this page only |
| `GET` | `/v1/setup/session` | device or operator | Phase, repo, GitHub — not public |
| `POST` | `/v1/setup/invites` | device | `{ url }` from the inviting device, not the Host header |
| `GET` | `/v1/setup/devices` | device | Names and ids. No tokens. |
| `DELETE` | `/v1/setup/devices/:id` | device | Revoke one. 409 on the last device. |
| `GET` | `/v1/setup/enrollments` | device | Pending approvals |
| `POST` | `/v1/setup/enrollments/:id/approve` | device | Issues that device's token |
| `POST` | `/v1/setup/enrollments/:id/deny` | device | |
| `POST` | `/v1/setup/ws-tickets` | device | `{ ticket, expiresAt }` |
| `POST` | `/v1/setup/github/*` | device or operator | Clone flow. Not required to enroll. The iPad runner page uses the device token. |

Phases: `pairing` → `github` → `clone` → `ready`.
