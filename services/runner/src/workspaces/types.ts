/** First-class workspace handle shared by sessions, VFS, and terminal. */

export const DEFAULT_WORKSPACE_ID = "default";

export type WorkspaceKind = "primary" | "worktree";

export interface Workspace {
  id: string;
  /** Absolute directory the agent / VFS / PTY use. */
  path: string;
  kind: WorkspaceKind;
}

export interface ListWorkspacesResponse {
  workspaces: Workspace[];
  defaultWorkspaceId: string;
}

export interface GetWorkspaceResponse {
  workspace: Workspace;
}

export function parseWorkspaceId(value?: string | null): string {
  const id = value?.trim();
  return id && id.length > 0 ? id : DEFAULT_WORKSPACE_ID;
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;

  constructor(id: string) {
    super(`Workspace not found: ${id}`);
    this.name = "WorkspaceNotFoundError";
  }
}
