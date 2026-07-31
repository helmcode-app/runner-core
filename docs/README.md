# runner-core documentation

API contracts and shared schemas for the HelmCode headless agent orchestration engine.

| Document | Description |
|----------|-------------|
| [Open-core HTTP API](./api/open-core.md) | Standalone server on `:8080` (`HELM_MODE=open-core`) |
| [Commercial SaaS JSON-RPC](./api/commercial-saas.md) | Outbound gateway control plane (`HELM_MODE=commercial-saas`) |
| [Shared types](./api/shared-types.md) | `AgentResult`, `TaskProgressEvent`, enums, error shapes |
| [VFS protocol](./api/vfs.md) | Go `helm-vfs` JSON-RPC + WebSocket `/v1/vfs` |

Source of truth for runtime behavior:

- Node: `services/runner/src/`
- Go VFS: `services/vfs/`
