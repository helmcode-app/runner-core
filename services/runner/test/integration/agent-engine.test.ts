import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { HelmCodeAgentEngine } from "../../src/agent/agentEngine.js";
import { AgentControllerRouter, AgentMethod } from "../../src/agent/agentRouter.js";
import { runCommandOrThrow } from "../../src/util/process.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
  waitFor,
} from "../helpers.js";

describe("HelmCodeAgentEngine integration", () => {
  let root = "";
  let mainRepoPath = "";
  let workspacesPath = "";
  let barePath = "";

  before(async () => {
    root = await makeTempDir("helm-engine-");
    const fx = await createLocalGitFixture(root);
    mainRepoPath = fx.mainRepoPath;
    workspacesPath = fx.workspacesPath;
    barePath = fx.barePath;
  });

  after(async () => {
    if (root) await removeTempDir(root);
  });

  it("runs full pipeline with timeline events and AI commit message", async () => {
    const originalFetch = globalThis.fetch;
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
                      path: "ENGINE_NOTE.md",
                      content: "# engine was here\n",
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
      const events: string[] = [];
      const engine = new HelmCodeAgentEngine({
        config: testConfig({
          MAIN_REPO_PATH: mainRepoPath,
          WORKSPACES_PATH: workspacesPath,
          MAX_TEST_RETRIES: "2",
          LLM_API_KEY: "sk-mock",
          LLM_BASE_URL: "https://llm.example/v1",
        }),
        logger: testLogger(),
        onProgress: (e) => events.push(e.stage ?? e.status),
      });

      const result = await engine.runFromParams({
        taskId: "eng-ok-1",
        prompt: "add ENGINE_NOTE.md for green tests",
        baseBranch: "main",
        testCommand: "test -f ENGINE_NOTE.md",
        contextPaths: ["README.md"],
        githubToken: "test-token-local",
      });

      assert.equal(result.status, "succeeded", result.error);
      assert.equal(result.branch, "aero-agent/eng-ok-1");
      assert.ok(result.commitSha);

      const mem = engine.getMemory("eng-ok-1");
      assert.ok(mem);
      assert.ok(mem!.events.some((e) => e.stage === "accepted"));
      assert.ok(mem!.events.some((e) => e.stage === "context_built"));
      assert.ok(mem!.events.some((e) => e.stage === "test_passed"));
      assert.ok(mem!.events.some((e) => e.stage === "success"));
      assert.ok(events.includes("test_passed"));

      const log = await runCommandOrThrow(
        "git",
        [
          "--git-dir",
          barePath,
          "log",
          "-1",
          "--format=%s",
          "aero-agent/eng-ok-1",
        ],
        { cwd: root },
      );
      assert.match(log.stdout, /AI Auto-Refactor \[HelmCode\]:/);

      await assert.rejects(
        () => access(path.join(workspacesPath, "ws_eng-ok-1")),
        /ENOENT/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("self-heals timeline records test_failed without succeeding", async () => {
    const engine = new HelmCodeAgentEngine({
      config: testConfig({
        MAIN_REPO_PATH: mainRepoPath,
        WORKSPACES_PATH: workspacesPath,
        MAX_TEST_RETRIES: "2",
      }),
      logger: testLogger(),
    });

    const result = await engine.runFromParams({
      taskId: "eng-fail-1",
      prompt: "cannot heal without real LLM patches",
      baseBranch: "main",
      testCommand: "false",
      contextPaths: ["hello.txt"],
      githubToken: "test-token-local",
      maxCycles: 2,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /tests still failing after 2/);
    assert.equal(result.testAttempts.length, 2);

    const mem = engine.getMemory("eng-fail-1");
    assert.ok(mem);
    const failedStages = mem!.events.filter((e) => e.stage === "test_failed");
    assert.ok(failedStages.length >= 1);
    assert.match(
      failedStages[0]!.message,
      /Cycle 1 failed\. Catching compile error/,
    );
    assert.ok(mem!.events.some((e) => e.stage === "self_healing"));
  });

  it("agent/run router accepts async and reports status", async () => {
    const engine = new HelmCodeAgentEngine({
      config: testConfig({
        MAIN_REPO_PATH: mainRepoPath,
        WORKSPACES_PATH: workspacesPath,
      }),
      logger: testLogger(),
    });
    const router = new AgentControllerRouter(engine, { asyncByDefault: true });

    const accepted = await router.handle({
      jsonrpc: "2.0",
      id: 10,
      method: AgentMethod.Run,
      params: {
        taskId: "eng-async-1",
        prompt: "async run",
        baseBranch: "main",
        testCommand: "true",
        contextPaths: ["README.md"],
        githubToken: "test-token-local",
      },
    });

    assert.ok(accepted && "result" in accepted);
    assert.equal(
      (accepted.result as { status: string }).status,
      "accepted",
    );

    await waitFor(async () => {
      const mem = engine.getMemory("eng-async-1");
      return mem?.result?.status === "succeeded" ? true : false;
    }, { timeoutMs: 30_000 });

    const status = await router.handle({
      jsonrpc: "2.0",
      id: 11,
      method: AgentMethod.Status,
      params: { taskId: "eng-async-1" },
    });
    assert.ok(status && "result" in status);
    const snap = status.result as { status: string; events: unknown[] };
    assert.equal(snap.status, "succeeded");
    assert.ok(Array.isArray(snap.events) && snap.events.length > 0);
  });
});
