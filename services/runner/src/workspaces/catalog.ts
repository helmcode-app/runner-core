/**
 * Persist extra (non-primary) workspaces under WORKSPACES_PATH/.setup.
 * Primary MAIN_REPO_PATH is always registered in-memory as `default`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Workspace, WorkspaceKind, WorkspaceRepoRef } from "./types.js";

const CATALOG_VERSION = 1 as const;

export interface WorkspaceCatalogEntry {
  id: string;
  path: string;
  kind: WorkspaceKind;
  repo?: WorkspaceRepoRef;
}

interface WorkspaceCatalogFile {
  version: typeof CATALOG_VERSION;
  projects: WorkspaceCatalogEntry[];
}

export function workspaceCatalogPath(workspacesPath: string): string {
  return path.join(workspacesPath, ".setup", "workspaces.json");
}

export async function loadWorkspaceCatalog(
  workspacesPath: string,
): Promise<WorkspaceCatalogEntry[]> {
  const file = workspaceCatalogPath(workspacesPath);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceCatalogFile;
    if (parsed.version !== CATALOG_VERSION || !Array.isArray(parsed.projects)) {
      return [];
    }
    return parsed.projects.filter(
      (row) =>
        typeof row?.id === "string" &&
        row.id.trim().length > 0 &&
        row.id !== "default" &&
        typeof row?.path === "string" &&
        row.path.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export async function saveWorkspaceCatalog(
  workspacesPath: string,
  projects: WorkspaceCatalogEntry[],
): Promise<void> {
  const file = workspaceCatalogPath(workspacesPath);
  await mkdir(path.dirname(file), { recursive: true });
  const body: WorkspaceCatalogFile = {
    version: CATALOG_VERSION,
    projects: projects.map((row) => ({
      id: row.id,
      path: row.path,
      kind: row.kind,
      ...(row.repo
        ? { repo: { owner: row.repo.owner, repo: row.repo.repo } }
        : {}),
    })),
  };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function toCatalogEntry(workspace: Workspace): WorkspaceCatalogEntry {
  return {
    id: workspace.id,
    path: workspace.path,
    kind: workspace.kind,
    ...(workspace.repo ? { repo: workspace.repo } : {}),
  };
}
