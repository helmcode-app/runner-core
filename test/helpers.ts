import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createLogger, type Logger } from "../src/logger.js";
import { runCommandOrThrow } from "../src/util/process.js";

export async function makeTempDir(prefix = "helm-runner-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function testLogger(): Logger {
  return createLogger({
    LOG_LEVEL: "error",
    mode: "open-core",
    version: "test",
  });
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    HELM_MODE: "open-core",
    MAIN_REPO_PATH: "/tmp/main_repo",
    WORKSPACES_PATH: "/tmp/workspaces",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "error",
    MAX_TEST_RETRIES: "3",
    DEFAULT_BASE_BRANCH: "main",
    GIT_USER_NAME: "Test Agent",
    GIT_USER_EMAIL: "test@helmcode.app",
    // Disable default budget in tests unless overridden.
    TASK_TIMEOUT_MS: "0",
    ...overrides,
  });
}

/**
 * Create a bare remote + working clone with an initial commit on `main`.
 * Returns paths suitable for agent integration tests (local push, no GitHub).
 */
export async function createLocalGitFixture(root: string): Promise<{
  barePath: string;
  mainRepoPath: string;
  workspacesPath: string;
}> {
  const barePath = path.join(root, "remote.git");
  const mainRepoPath = path.join(root, "main_repo");
  const workspacesPath = path.join(root, "workspaces");
  await mkdir(workspacesPath, { recursive: true });

  await runCommandOrThrow("git", ["init", "--bare", barePath], { cwd: root });
  await runCommandOrThrow("git", ["clone", barePath, mainRepoPath], {
    cwd: root,
  });

  const gitEnv = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@helmcode.app",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@helmcode.app",
  };

  await runCommandOrThrow(
    "git",
    ["checkout", "-b", "main"],
    { cwd: mainRepoPath, env: gitEnv },
  );
  await writeFile(path.join(mainRepoPath, "README.md"), "# fixture\n", "utf8");
  await writeFile(
    path.join(mainRepoPath, "hello.txt"),
    "hello\n",
    "utf8",
  );
  await runCommandOrThrow("git", ["add", "-A"], {
    cwd: mainRepoPath,
    env: gitEnv,
  });
  await runCommandOrThrow("git", ["commit", "-m", "initial"], {
    cwd: mainRepoPath,
    env: gitEnv,
  });
  await runCommandOrThrow("git", ["push", "-u", "origin", "main"], {
    cwd: mainRepoPath,
    env: gitEnv,
  });
  // Ensure origin/main exists for worktree start-point.
  await runCommandOrThrow("git", ["fetch", "origin"], {
    cwd: mainRepoPath,
    env: gitEnv,
  });

  return { barePath, mainRepoPath, workspacesPath };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 50;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
