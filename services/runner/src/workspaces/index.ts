export {
  createWorkspaceRegistry,
  WorkspaceRegistry,
} from "./registry.js";
export { handleWorkspaceHttp, type WorkspaceRouteContext } from "./routes.js";
export {
  DEFAULT_WORKSPACE_ID,
  parseWorkspaceId,
  WorkspaceNotFoundError,
  type GetWorkspaceResponse,
  type ListWorkspacesResponse,
  type Workspace,
  type WorkspaceKind,
} from "./types.js";
