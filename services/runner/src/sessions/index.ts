/**
 * Agent sessions API — stable Helm DTOs; runtime adapter is pluggable.
 *
 * Package layout:
 *   types.ts      Public DTOs
 *   routes.ts     HTTP `/v1/sessions/*`
 *   errors.ts     Upstream → HTTP errors
 *   mapper.ts     Wire → session + timeline
 *   map-tools.ts  Tool/patch → ToolAction
 *   map-util.ts   Shared field helpers
 *   models.ts     Provider model catalog
 *   sse.ts        Event stream proxy
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
  mapProviderCatalog,
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
