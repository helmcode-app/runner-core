/**
 * Agent sessions API — stable Helm DTOs; runtime adapter is pluggable.
 *
 * Package layout:
 *   types.ts            Public DTOs
 *   routes.ts           HTTP dispatch for `/v1/sessions/*`
 *   handlers.ts         Route handlers (health, models, CRUD, prompt, …)
 *   errors.ts           Upstream → HTTP errors
 *   mapper.ts           Wire → session + timeline
 *   map-tools.ts        Tool/patch → ToolAction labels
 *   map-tool-content.ts Extract path/diff body from tool parts
 *   map-util.ts         Shared field helpers
 *   models.ts           Provider catalog map + load
 *   models-cache.ts     Short TTL catalog cache
 *   sse.ts              Event stream proxy
 */
export {
  handleSessionHttp,
  type SessionRouteContext,
} from "./routes.js";
export {
  mapSession,
  mapSessionList,
  mapHistoryToTimeline,
  type ToolAction,
} from "./mapper.js";
export {
  clearProviderCatalogCache,
  getCachedProviderCatalog,
  loadSessionModelsCatalog,
  mapProviderCatalog,
  setCachedProviderCatalog,
  type SessionModelOption,
  type SessionModelsResponse,
} from "./models.js";
export type {
  AgentSession,
  SessionMode,
  SessionStatus,
  TimelineEntry,
  TimelineKind,
  TimelineRole,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  GetSessionResponse,
  PromptRequest,
  PromptAccepted,
  SessionHistoryResponse,
  AbortResponse,
  RevertSessionRequest,
  RevertSessionResponse,
  SessionDiffResponse,
  RuntimeHealthResponse,
  SessionStreamEvent,
} from "./types.js";
