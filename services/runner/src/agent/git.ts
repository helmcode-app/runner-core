import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureDir, pathExists } from "../util/fs.js";
import { runCommand, runCommandOrThrow } from "../util/process.js";
import {
  redactGitSecrets,
  resolveGithubToken,
} from "../util/github-token.js";

export { resolveGithubToken, redactGitSecrets } from "../util/github-token.js";

export interface WorktreeHandle {
  taskId: string;
  branch: string;
  worktreePath: string;
  mainRepoPath: string;
  baseBranch: string;
}

function sanitizeTaskId(taskId: string): string {
  const cleaned = taskId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  if (!cleaned) throw new Error("task id is empty after sanitization");
  return cleaned;
}

export function branchNameForTask(taskId: string): string {
  return `aero-agent/${sanitizeTaskId(taskId)}`;
}

export function worktreeDirForTask(
  workspacesPath: string,
  taskId: string,
): string {
  return path.join(workspacesPath, `ws_${sanitizeTaskId(taskId)}`);
}

function wrapGitError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const redacted = redactGitSecrets(msg);
  if (/terminal prompts disabled/i.test(redacted)) {
    return new Error(
      `${redacted}\n` +
        "Hint: git cannot prompt for credentials in the agent sandbox. " +
        "Set a valid GITHUB_TOKEN (ghp_…) in runner-core/.env or pass " +
        "agent/run.githubToken. Do not put a fake token in GITHUB_TOKEN. " +
        "Open Project Bearer is OPENCORE_API_TOKEN, not a GitHub PAT.",
    );
  }
  if (err instanceof Error) {
    return new Error(redacted, { cause: err });
  }
  return new Error(redacted);
}

export class GitOrchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  private gitEnv(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      // Never hang waiting for interactive username/password in the sandbox.
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: this.config.GIT_USER_NAME,
      GIT_AUTHOR_EMAIL: this.config.GIT_USER_EMAIL,
      GIT_COMMITTER_NAME: this.config.GIT_USER_NAME,
      GIT_COMMITTER_EMAIL: this.config.GIT_USER_EMAIL,
    };
    // Prefer HTTPS token auth via extraheader when a *real* token is supplied.
    // Invalid/placeholder tokens must not be injected — they override URL creds
    // and cause: fatal: could not read Password … terminal prompts disabled.
    const resolved = resolveGithubToken(token);
    if (resolved) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${resolved}`).toString("base64")}`;
    }
    return env;
  }

  async ensureMainRepo(repoPath: string): Promise<void> {
    const exists = await pathExists(path.join(repoPath, ".git"));
    if (!exists) {
      // Bare-ish check: allow both regular clone and worktree-capable checkouts.
      const alt = await pathExists(repoPath);
      if (!alt) {
        throw new Error(
          `Main repository not found at ${repoPath}. Mount or clone the target repo before starting the runner.`,
        );
      }
      const probe = await runCommand("git", ["rev-parse", "--git-dir"], {
        cwd: repoPath,
      });
      if (probe.exitCode !== 0) {
        throw new Error(`Path ${repoPath} is not a git repository`);
      }
    }
  }

  async fetch(
    mainRepoPath: string,
    remote = "origin",
    token?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.log.info("git fetch", { mainRepoPath, remote });
    try {
      await runCommandOrThrow("git", ["fetch", "--prune", "--tags", remote], {
        cwd: mainRepoPath,
        env: this.gitEnv(token),
        timeoutMs: 120_000,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (err) {
      throw wrapGitError(err);
    }
  }

  async createWorktree(params: {
    taskId: string;
    mainRepoPath: string;
    baseBranch: string;
    remote?: string;
    token?: string;
    signal?: AbortSignal;
  }): Promise<WorktreeHandle> {
    const remote = params.remote ?? "origin";
    const branch = branchNameForTask(params.taskId);
    const worktreePath = worktreeDirForTask(
      this.config.WORKSPACES_PATH,
      params.taskId,
    );

    await ensureDir(this.config.WORKSPACES_PATH);
    await this.ensureMainRepo(params.mainRepoPath);
    await this.fetch(
      params.mainRepoPath,
      remote,
      params.token,
      params.signal,
    );

    // Drop stale worktree / branch if a previous run left debris.
    await this.forceCleanup(params.mainRepoPath, worktreePath, branch);

    const startPoint = `${remote}/${params.baseBranch}`;
    this.log.info("git worktree add", {
      worktreePath,
      branch,
      startPoint,
    });

    await runCommandOrThrow(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, startPoint],
      {
        cwd: params.mainRepoPath,
        env: this.gitEnv(params.token),
        timeoutMs: 60_000,
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      },
    );

    return {
      taskId: params.taskId,
      branch,
      worktreePath,
      mainRepoPath: params.mainRepoPath,
      baseBranch: params.baseBranch,
    };
  }

  async statusPorcelain(
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const r = await runCommandOrThrow("git", ["status", "--porcelain"], {
      cwd: worktreePath,
      ...(signal !== undefined ? { signal } : {}),
    });
    return r.stdout.trim();
  }

  async addAll(worktreePath: string, signal?: AbortSignal): Promise<void> {
    await runCommandOrThrow("git", ["add", "-A"], {
      cwd: worktreePath,
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async commit(
    worktreePath: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const status = await this.statusPorcelain(worktreePath, signal);
    if (!status) {
      this.log.warn("nothing to commit", { worktreePath });
      const head = await runCommandOrThrow("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        ...(signal !== undefined ? { signal } : {}),
      });
      return head.stdout.trim();
    }

    await this.addAll(worktreePath, signal);
    await runCommandOrThrow(
      "git",
      ["commit", "-m", message, "--no-gpg-sign"],
      {
        cwd: worktreePath,
        env: this.gitEnv(),
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    const head = await runCommandOrThrow("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      ...(signal !== undefined ? { signal } : {}),
    });
    return head.stdout.trim();
  }

  async push(params: {
    worktreePath: string;
    branch: string;
    remote?: string;
    token?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const remote = params.remote ?? "origin";
    const token = resolveGithubToken(params.token, this.config.GITHUB_TOKEN);
    if (!token) {
      throw new Error(
        "github_token / GITHUB_TOKEN is required to push agent branches. " +
          "Set a real PAT in runner-core/.env (GITHUB_TOKEN=ghp_…) or pass " +
          "agent/run params.githubToken. Open Project API token is NOT a GitHub token.",
      );
    }
    this.log.info("git push", {
      worktreePath: params.worktreePath,
      branch: params.branch,
      remote,
    });
    try {
      await runCommandOrThrow(
        "git",
        ["push", "-u", remote, `HEAD:refs/heads/${params.branch}`],
        {
          cwd: params.worktreePath,
          env: this.gitEnv(token),
          timeoutMs: 120_000,
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        },
      );
    } catch (err) {
      throw wrapGitError(err);
    }
  }

  async removeWorktree(
    mainRepoPath: string,
    worktreePath: string,
  ): Promise<void> {
    this.log.info("git worktree remove", { worktreePath });
    const result = await runCommand(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: mainRepoPath, timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) {
      // Fallback: prune + force rm if worktree metadata is inconsistent.
      this.log.warn("worktree remove failed; pruning", {
        stderr: result.stderr,
      });
      await runCommand("git", ["worktree", "prune"], { cwd: mainRepoPath });
      await runCommand("rm", ["-rf", worktreePath], { cwd: "/" });
    }
  }

  private async forceCleanup(
    mainRepoPath: string,
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    if (await pathExists(worktreePath)) {
      await this.removeWorktree(mainRepoPath, worktreePath);
    }
    // Delete local branch if it already exists (previous failed run).
    await runCommand("git", ["branch", "-D", branch], {
      cwd: mainRepoPath,
    });
  }
}
