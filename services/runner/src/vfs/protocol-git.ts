/**
 * VFS git wire types and method name fragments.
 * Keep in sync with services/vfs/internal/vfs/git_protocol.go.
 */

export const VfsGitMethod = {
  /** Read-only working-tree status (branch / upstream / changes). */
  GitStatus: "vfs/gitStatus",
  /** Local branches, remote-tracking branches, and tags. */
  GitRefs: "vfs/gitRefs",
  /** Unified diff for one path (unstaged by default; staged via params). */
  GitDiff: "vfs/gitDiff",
  /** File contents at a revision (default HEAD) for merge/diff views. */
  GitShow: "vfs/gitShow",
  /** Switch HEAD to a local/remote branch or tag. */
  GitCheckout: "vfs/gitCheckout",
} as const;

export type VfsGitMethodName =
  (typeof VfsGitMethod)[keyof typeof VfsGitMethod];

export type VfsGitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "untracked"
  | "renamed";

export interface VfsGitChangeEntry {
  path: string;
  status: VfsGitChangeStatus;
  staged: boolean;
  /** Previous path when status is renamed. */
  fromPath?: string;
}

export interface VfsGitStatusResult {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  changes: VfsGitChangeEntry[];
}

export interface VfsGitRefEntry {
  name: string;
  tip?: string;
  isCurrent?: boolean;
}

export interface VfsGitRefsResult {
  isRepo: boolean;
  localBranches: VfsGitRefEntry[];
  remoteBranches: VfsGitRefEntry[];
  tags: VfsGitRefEntry[];
}

export interface VfsGitDiffParams {
  path: string;
  /** When true, diff the index vs HEAD (`git diff --cached`). */
  staged?: boolean;
}

export interface VfsGitDiffResult {
  path: string;
  staged: boolean;
  /** Unified diff text (empty when clean / binary / unavailable). */
  diff: string;
  truncated?: boolean;
}

export interface VfsGitShowParams {
  path: string;
  /** Git revision; defaults to HEAD on the server. */
  revision?: string;
}

export interface VfsGitShowResult {
  path: string;
  revision: string;
  exists: boolean;
  content?: string;
  truncated?: boolean;
  binary?: boolean;
}

export type VfsGitRefKind = "localBranch" | "remoteBranch" | "tag";

export interface VfsGitCheckoutParams {
  ref: string;
  kind: VfsGitRefKind;
}

export interface VfsGitCheckoutResult {
  ref: string;
  kind: VfsGitRefKind;
  branch?: string;
  detached?: boolean;
}
