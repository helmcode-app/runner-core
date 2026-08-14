/**
 * Workspace checkpoints for session rewind.
 *
 * Snapshots live in the repo object db via a temp index (`git write-tree`).
 * They do not create commits or touch the user's branch. Restore uses
 * `git read-tree -u --reset` plus deletion of files created after the snapshot.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, runCommandOrThrow } from "../util/process.js";

const GIT_TIMEOUT_MS = 60_000;

export interface WorkspaceCheckpoint {
  /** `git write-tree` SHA stored in the repo object database. */
  tree: string;
  /** Relative paths included in the tree. */
  paths: string[];
}

export async function isGitWorkTree(cwd: string): Promise<boolean> {
  const result = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeoutMs: 10_000,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

export async function captureWorkspaceCheckpoint(
  cwd: string,
): Promise<WorkspaceCheckpoint | null> {
  if (!(await isGitWorkTree(cwd))) return null;

  const indexFile = tempIndexPath();
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runCommandOrThrow("git", ["add", "-A"], {
      cwd,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const tree = (
      await runCommandOrThrow("git", ["write-tree"], {
        cwd,
        env,
        timeoutMs: GIT_TIMEOUT_MS,
      })
    ).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) {
      throw new Error(`git write-tree returned invalid sha: ${tree}`);
    }
    const listed = await runCommandOrThrow(
      "git",
      ["ls-tree", "-r", "--name-only", tree],
      { cwd, env, timeoutMs: GIT_TIMEOUT_MS },
    );
    return {
      tree,
      paths: splitPaths(listed.stdout),
    };
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

export async function restoreWorkspaceCheckpoint(
  cwd: string,
  tree: string,
): Promise<{ restored: string[]; removed: string[] }> {
  if (!(await isGitWorkTree(cwd))) {
    throw new Error("workspace is not a git worktree");
  }

  const before = await listWorktreePaths(cwd);
  await runCommandOrThrow("git", ["read-tree", "-u", "--reset", tree], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });

  const target = new Set(
    splitPaths(
      (
        await runCommandOrThrow("git", ["ls-tree", "-r", "--name-only", tree], {
          cwd,
          timeoutMs: GIT_TIMEOUT_MS,
        })
      ).stdout,
    ),
  );
  const removed: string[] = [];
  for (const rel of before) {
    if (target.has(rel)) continue;
    await rm(path.join(cwd, rel), { force: true }).catch(() => undefined);
    removed.push(rel);
  }

  return { restored: [...target], removed };
}

async function listWorktreePaths(cwd: string): Promise<string[]> {
  const listed = await runCommandOrThrow(
    "git",
    ["ls-files", "-co", "--exclude-standard"],
    { cwd, timeoutMs: GIT_TIMEOUT_MS },
  );
  return splitPaths(listed.stdout);
}

function splitPaths(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function tempIndexPath(): string {
  return path.join(os.tmpdir(), `helm-checkpoint-${randomUUID()}.idx`);
}
