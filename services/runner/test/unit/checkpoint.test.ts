import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  captureWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from "../../src/agent/checkpoint.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
} from "../helpers.js";

describe("workspace checkpoint", () => {
  let root = "";
  let cwd = "";

  before(async () => {
    root = await makeTempDir("helm-checkpoint-");
    const fixture = await createLocalGitFixture(root);
    cwd = fixture.mainRepoPath;
  });

  after(async () => {
    if (root) await removeTempDir(root);
  });

  it("restores tracked edits and removes files added after the snapshot", async () => {
    const hello = path.join(cwd, "hello.txt");
    const extra = path.join(cwd, "extra.txt");

    await writeFile(hello, "before\n", "utf8");
    const snap = await captureWorkspaceCheckpoint(cwd);
    assert.ok(snap?.tree);

    await writeFile(hello, "after\n", "utf8");
    await writeFile(extra, "new\n", "utf8");

    const result = await restoreWorkspaceCheckpoint(cwd, snap!.tree);
    assert.equal(await readFile(hello, "utf8"), "before\n");
    await assert.rejects(() => readFile(extra, "utf8"));
    assert.ok(result.removed.includes("extra.txt"));

    await rm(extra, { force: true });
    await writeFile(hello, "hello\n", "utf8");
  });
});
