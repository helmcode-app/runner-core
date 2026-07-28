import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AgentPipeline } from "../../src/core/agent.js";
import { runCommandOrThrow } from "../../src/util/process.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
} from "../helpers.js";

describe("AgentPipeline integration", () => {
  let root = "";
  let mainRepoPath = "";
  let workspacesPath = "";
  let barePath = "";

  before(async () => {
    root = await makeTempDir("helm-agent-");
    const fx = await createLocalGitFixture(root);
    mainRepoPath = fx.mainRepoPath;
    workspacesPath = fx.workspacesPath;
    barePath = fx.barePath;
  });

  after(async () => {
    if (root) await removeTempDir(root);
  });

  it("completes fetch → worktree → tests → commit → push → cleanup", async () => {
    const config = testConfig({
      MAIN_REPO_PATH: mainRepoPath,
      WORKSPACES_PATH: workspacesPath,
      MAX_TEST_RETRIES: "2",
      // no LLM_API_KEY → empty patches; tests still green with `true`
    });

    const agent = new AgentPipeline({
      config,
      logger: testLogger(),
    });

    const result = await agent.run({
      id: "it-success-1",
      prompt: "no-op change for integration test",
      baseBranch: "main",
      testCommand: "true",
      githubToken: "test-token-local",
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.branch, "aero-agent/it-success-1");
    assert.ok(result.commitSha);
    assert.equal(result.pushRemote, "origin");
    assert.ok(result.testAttempts.length >= 1);
    assert.equal(result.testAttempts[0]?.result.exitCode, 0);

    // Worktree cleaned up.
    await assert.rejects(
      () => access(path.join(workspacesPath, "ws_it-success-1")),
      /ENOENT/,
    );

    // Branch exists on the bare remote.
    const branches = await runCommandOrThrow(
      "git",
      ["--git-dir", barePath, "branch", "--list", "aero-agent/it-success-1"],
      { cwd: root },
    );
    assert.match(branches.stdout, /aero-agent\/it-success-1/);
  });

  it("fails after self-healing retries when tests never pass", async () => {
    const config = testConfig({
      MAIN_REPO_PATH: mainRepoPath,
      WORKSPACES_PATH: workspacesPath,
      MAX_TEST_RETRIES: "2",
    });

    const agent = new AgentPipeline({
      config,
      logger: testLogger(),
    });

    const result = await agent.run({
      id: "it-fail-1",
      prompt: "cannot fix failing tests without LLM patches",
      baseBranch: "main",
      testCommand: "false",
      githubToken: "test-token-local",
    });

    assert.equal(result.status, "failed");
    assert.ok(result.error);
    assert.match(result.error ?? "", /tests still failing after 2/);
    assert.equal(result.testAttempts.length, 2);
    assert.ok(result.testAttempts.every((t) => t.result.exitCode !== 0));

    // Worktree still cleaned on failure.
    await assert.rejects(
      () => access(path.join(workspacesPath, "ws_it-fail-1")),
      /ENOENT/,
    );
  });

  it("applies mocked LLM patches that create a tracked file", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "add note",
                  patches: [
                    {
                      path: "AGENT_NOTE.md",
                      content: "# agent was here\n",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    try {
      const config = testConfig({
        MAIN_REPO_PATH: mainRepoPath,
        WORKSPACES_PATH: workspacesPath,
        LLM_API_KEY: "sk-mock",
        LLM_BASE_URL: "https://llm.example/v1",
      });

      const agent = new AgentPipeline({
        config,
        logger: testLogger(),
      });

      const result = await agent.run({
        id: "it-patch-1",
        prompt: "add AGENT_NOTE.md",
        baseBranch: "main",
        testCommand: "test -f AGENT_NOTE.md",
        githubToken: "test-token-local",
      });

      assert.equal(result.status, "succeeded", result.error);
      assert.ok(result.commitSha);

      // Verify remote branch contains the file.
      const show = await runCommandOrThrow(
        "git",
        [
          "--git-dir",
          barePath,
          "show",
          "aero-agent/it-patch-1:AGENT_NOTE.md",
        ],
        { cwd: root },
      );
      assert.match(show.stdout, /agent was here/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
