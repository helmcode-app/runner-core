/**
 * In-process workspace catalog.
 *
 * Today: one `default` workspace at MAIN_REPO_PATH.
 * Later: add `worktree` entries under WORKSPACES_PATH without changing
 * session / VFS / terminal wire shapes.
 */

import type { AppConfig } from "../config.js";
import {
  DEFAULT_WORKSPACE_ID,
  parseWorkspaceId,
  WorkspaceNotFoundError,
  type Workspace,
} from "./types.js";

export class WorkspaceRegistry {
  private readonly byId = new Map<string, Workspace>();

  constructor(config: AppConfig) {
    this.byId.set(DEFAULT_WORKSPACE_ID, {
      id: DEFAULT_WORKSPACE_ID,
      path: config.MAIN_REPO_PATH,
      kind: "primary",
    });
  }

  list(): Workspace[] {
    return [...this.byId.values()];
  }

  get(id?: string | null): Workspace {
    const resolved = parseWorkspaceId(id);
    const workspace = this.byId.get(resolved);
    if (!workspace) throw new WorkspaceNotFoundError(resolved);
    return workspace;
  }

  defaultId(): string {
    return DEFAULT_WORKSPACE_ID;
  }
}

export function createWorkspaceRegistry(config: AppConfig): WorkspaceRegistry {
  return new WorkspaceRegistry(config);
}
