import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureDir, pathExists } from "../util/fs.js";
import { runCommand, runCommandOrThrow } from "../util/process.js";

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

export function worktreeDirForTask(workspacesPath: string, taskId: string): string {
  return path.join(workspacesPath, `ws_${sanitizeTaskId(taskId)}`);
}

export class GitOrchestrator {
  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  private gitEnv(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: this.config.GIT_USER_NAME,
      GIT_AUTHOR_EMAIL: this.config.GIT_USER_EMAIL,
      GIT_COMMITTER_NAME: this.config.GIT_USER_NAME,
      GIT_COMMITTER_EMAIL: this.config.GIT_USER_EMAIL,
    };
    // Prefer HTTPS token auth via extraheader when a token is supplied.
    if (token) {
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
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

  async fetch(mainRepoPath: string, remote = "origin", token?: string): Promise<void> {
    this.log.info("git fetch", { mainRepoPath, remote });
    await runCommandOrThrow("git", ["fetch", "--prune", "--tags", remote], {
      cwd: mainRepoPath,
      env: this.gitEnv(token),
      timeoutMs: 120_000,
    });
  }

  async createWorktree(params: {
    taskId: string;
    mainRepoPath: string;
    baseBranch: string;
    remote?: string;
    token?: string;
  }): Promise<WorktreeHandle> {
    const remote = params.remote ?? "origin";
    const branch = branchNameForTask(params.taskId);
    const worktreePath = worktreeDirForTask(
      this.config.WORKSPACES_PATH,
      params.taskId,
    );

    await ensureDir(this.config.WORKSPACES_PATH);
    await this.ensureMainRepo(params.mainRepoPath);
    await this.fetch(params.mainRepoPath, remote, params.token);

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

  async statusPorcelain(worktreePath: string): Promise<string> {
    const r = await runCommandOrThrow("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    });
    return r.stdout.trim();
  }

  async addAll(worktreePath: string): Promise<void> {
    await runCommandOrThrow("git", ["add", "-A"], { cwd: worktreePath });
  }

  async commit(worktreePath: string, message: string): Promise<string | undefined> {
    const status = await this.statusPorcelain(worktreePath);
    if (!status) {
      this.log.warn("nothing to commit", { worktreePath });
      const head = await runCommandOrThrow("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
      });
      return head.stdout.trim();
    }

    await this.addAll(worktreePath);
    await runCommandOrThrow(
      "git",
      ["commit", "-m", message, "--no-gpg-sign"],
      {
        cwd: worktreePath,
        env: this.gitEnv(),
      },
    );
    const head = await runCommandOrThrow("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
    });
    return head.stdout.trim();
  }

  async push(params: {
    worktreePath: string;
    branch: string;
    remote?: string;
    token?: string;
  }): Promise<void> {
    const remote = params.remote ?? "origin";
    const token = params.token ?? this.config.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        "github_token / GITHUB_TOKEN is required to push agent branches",
      );
    }
    this.log.info("git push", {
      worktreePath: params.worktreePath,
      branch: params.branch,
      remote,
    });
    await runCommandOrThrow(
      "git",
      ["push", "-u", remote, `HEAD:refs/heads/${params.branch}`],
      {
        cwd: params.worktreePath,
        env: this.gitEnv(token),
        timeoutMs: 120_000,
      },
    );
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
