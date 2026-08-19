/**
 * Agent sessions API — stable Helm DTOs over ACP Agent Gateway.
 *
 * Package layout:
 *   types.ts     Public DTOs
 *   routes.ts    HTTP dispatch for `/v1/sessions/*`
 *   handlers.ts  Route handlers
 *   errors.ts    Gateway → HTTP errors
 *   sse.ts       Event stream from gateway
 */
export {
  handleSessionHttp,
  type SessionRouteContext,
} from "./routes.js";
export type {
  AgentSession,
  SessionMode,
  SessionStatus,
  SessionUsage,
  SessionUsageCost,
  ThinkLevel,
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
  CancelResponse,
  RewindRestore,
  RewindRequest,
  RewindResponse,
  SessionModel,
  SessionModelsResponse,
  RuntimeHealthResponse,
  SessionStreamEvent,
} from "./types.js";
