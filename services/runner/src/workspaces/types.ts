/** First-class workspace handle shared by sessions, VFS, and terminal. */

export const DEFAULT_WORKSPACE_ID = "default";

export type WorkspaceKind = "primary" | "project" | "worktree";

export interface WorkspaceRepoRef {
  owner: string;
  repo: string;
}

export interface Workspace {
  id: string;
  /** Absolute directory the agent / VFS / PTY use. */
  path: string;
  kind: WorkspaceKind;
  /** GitHub slug when this workspace was cloned via setup. */
  repo?: WorkspaceRepoRef;
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

/** Stable id for an owner/repo pair under WORKSPACES_PATH/projects. */
export function workspaceIdForRepo(owner: string, repo: string): string {
  const clean = (value: string): string => {
    const next = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return next || "x";
  };
  return `${clean(owner)}--${clean(repo)}`;
}

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;

  constructor(id: string) {
    super(`Workspace not found: ${id}`);
    this.name = "WorkspaceNotFoundError";
  }
}
