import { chmod, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { runCommandOrThrow } from "../util/process.js";

export async function assertCloneDestination(dest: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dest);
  } catch {
    await mkdir(dest, { recursive: true });
    return;
  }
  const leftover = names.filter((n) => n !== ".DS_Store" && n !== "lost+found");
  if (leftover.length > 0) {
    throw new Error(`clone destination is not empty (${dest})`);
  }
}

export async function cloneGithubRepo(opts: {
  dest: string;
  owner: string;
  repo: string;
  accessToken: string;
  ref?: string;
}): Promise<void> {
  await assertCloneDestination(opts.dest);
  const askPass = path.join(os.tmpdir(), `helm-git-askpass-${process.pid}.sh`);
  await writeFile(
    askPass,
    "#!/bin/sh\nprintf '%s\\n' \"$HELM_GITHUB_TOKEN\"\n",
    {
      mode: 0o700,
    },
  );
  await chmod(askPass, 0o700);
  const url = `https://x-access-token@github.com/${opts.owner}/${opts.repo}.git`;
  try {
    await runCommandOrThrow("git", ["clone", "--", url, opts.dest], {
      cwd: os.tmpdir(),
      timeoutMs: 120_000,
      env: {
        ...process.env,
        GIT_ASKPASS: askPass,
        GIT_TERMINAL_PROMPT: "0",
        HELM_GITHUB_TOKEN: opts.accessToken,
      },
    });
    if (opts.ref?.trim()) {
      await runCommandOrThrow("git", ["checkout", opts.ref.trim()], {
        cwd: opts.dest,
        timeoutMs: 30_000,
      });
    }
  } finally {
    await rm(askPass, { force: true }).catch(() => undefined);
  }
}
