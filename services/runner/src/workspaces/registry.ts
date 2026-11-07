/**
 * In-process workspace catalog.
 *
 * - `default` always points at MAIN_REPO_PATH (kind: primary).
 * - Extra cloned repos live under WORKSPACES_PATH/projects/<id>
 *   and are persisted in WORKSPACES_PATH/.setup/workspaces.json.
 */

import path from "node:path";
import type { AppConfig } from "../config.js";
import {
  loadWorkspaceCatalog,
  saveWorkspaceCatalog,
  toCatalogEntry,
} from "./catalog.js";
import {
  DEFAULT_WORKSPACE_ID,
  parseWorkspaceId,
  WorkspaceNotFoundError,
  workspaceIdForRepo,
  type Workspace,
  type WorkspaceRepoRef,
} from "./types.js";

export class WorkspaceRegistry {
  private readonly byId = new Map<string, Workspace>();
  private readonly workspacesPath: string;
  private readonly mainRepoPath: string;

  constructor(config: AppConfig) {
    this.workspacesPath = config.WORKSPACES_PATH;
    this.mainRepoPath = config.MAIN_REPO_PATH;
    this.byId.set(DEFAULT_WORKSPACE_ID, {
      id: DEFAULT_WORKSPACE_ID,
      path: config.MAIN_REPO_PATH,
      kind: "primary",
    });
  }

  async load(): Promise<void> {
    const rows = await loadWorkspaceCatalog(this.workspacesPath);
    for (const row of rows) {
      if (row.id === DEFAULT_WORKSPACE_ID) continue;
      this.byId.set(row.id, {
        id: row.id,
        path: row.path,
        kind: row.kind === "worktree" ? "worktree" : "project",
        ...(row.repo ? { repo: row.repo } : {}),
      });
    }
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

  findByRepo(owner: string, repo: string): Workspace | undefined {
    const o = owner.trim().toLowerCase();
    const r = repo.trim().toLowerCase();
    for (const workspace of this.byId.values()) {
      if (
        workspace.repo &&
        workspace.repo.owner.toLowerCase() === o &&
        workspace.repo.repo.toLowerCase() === r
      ) {
        return workspace;
      }
    }
    return undefined;
  }

  /** Attach GitHub metadata onto the primary workspace (MAIN_REPO clone). */
  setPrimaryRepo(repo: WorkspaceRepoRef): void {
    const primary = this.byId.get(DEFAULT_WORKSPACE_ID);
    if (!primary) return;
    this.byId.set(DEFAULT_WORKSPACE_ID, {
      ...primary,
      repo: { owner: repo.owner, repo: repo.repo },
    });
  }

  projectsRoot(): string {
    return path.join(this.workspacesPath, "projects");
  }

  projectPathFor(owner: string, repo: string): { id: string; path: string } {
    const id = workspaceIdForRepo(owner, repo);
    return { id, path: path.join(this.projectsRoot(), id) };
  }

  async addProject(input: {
    id?: string;
    path: string;
    owner: string;
    repo: string;
  }): Promise<Workspace> {
    const id = (input.id?.trim() || workspaceIdForRepo(input.owner, input.repo));
    if (id === DEFAULT_WORKSPACE_ID) {
      throw new Error("cannot register primary workspace as a project");
    }
    if (this.byId.has(id)) {
      throw new Error(`workspace already registered: ${id}`);
    }
    const workspace: Workspace = {
      id,
      path: input.path,
      kind: "project",
      repo: { owner: input.owner.trim(), repo: input.repo.trim() },
    };
    this.byId.set(id, workspace);
    await this.persistProjects();
    return workspace;
  }

  private async persistProjects(): Promise<void> {
    const projects = [...this.byId.values()]
      .filter((row) => row.id !== DEFAULT_WORKSPACE_ID)
      .map(toCatalogEntry);
    await saveWorkspaceCatalog(this.workspacesPath, projects);
  }
}

export async function createWorkspaceRegistry(
  config: AppConfig,
): Promise<WorkspaceRegistry> {
  const registry = new WorkspaceRegistry(config);
  await registry.load();
  return registry;
}
