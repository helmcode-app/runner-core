import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AgentResult } from "../../src/types.js";
import { startOpenCore, type OpenCoreServer } from "../../src/modes/open-core.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
  waitFor,
} from "../helpers.js";

describe("open-core HTTP API", () => {
  let root = "";
  let svc: OpenCoreServer | undefined;

  before(async () => {
    root = await makeTempDir("helm-http-");
    const fx = await createLocalGitFixture(root);
    const config = testConfig({
      MAIN_REPO_PATH: fx.mainRepoPath,
      WORKSPACES_PATH: fx.workspacesPath,
      HOST: "127.0.0.1",
      PORT: "0",
      GITHUB_TOKEN: "test-token-local",
    });
    svc = await startOpenCore(config, testLogger(), {
      installSignalHandlers: false,
    });
  });

  after(async () => {
    await svc?.close();
    if (root) await removeTempDir(root);
  });

  function url(p: string): string {
    assert.ok(svc);
    return `${svc.baseUrl}${p}`;
  }

  it("GET /health", async () => {
    const res = await fetch(url("/health"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      activeTasks: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.mode, "open-core");
    assert.equal(typeof body.activeTasks, "number");
  });

  it("GET /v1/status", async () => {
    const res = await fetch(url("/v1/status"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      mode: string;
      knownTasks: number;
    };
    assert.equal(body.mode, "open-core");
    assert.equal(typeof body.knownTasks, "number");
  });

  it("POST /v1/tasks rejects empty prompt", async () => {
    const res = await fetch(url("/v1/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "   " }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /prompt is required/);
  });

  it("POST /v1/tasks + GET poll completes successfully", async () => {
    const submit = await fetch(url("/v1/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-task-1",
        prompt: "integration http task",
        testCommand: "true",
      }),
    });
    assert.equal(submit.status, 202);
    const accepted = (await submit.json()) as {
      id: string;
      status: string;
      poll: string;
    };
    assert.equal(accepted.id, "http-task-1");
    assert.equal(accepted.status, "queued");
    assert.equal(accepted.poll, "/v1/tasks/http-task-1");

    // Duplicate id → 409
    const dup = await fetch(url("/v1/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-task-1",
        prompt: "again",
      }),
    });
    assert.equal(dup.status, 409);

    const final = await waitFor(async () => {
      const res = await fetch(url("/v1/tasks/http-task-1"));
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        result: AgentResult | null;
        events: unknown[];
      };
      if (body.result) return body;
      return null;
    });

    assert.equal(final.status, "succeeded");
    assert.equal(final.result?.status, "succeeded");
    assert.ok(Array.isArray(final.events));
  });

  it("POST /v1/tasks/sync returns AgentResult", async () => {
    const res = await fetch(url("/v1/tasks/sync"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-sync-1",
        prompt: "sync path",
        testCommand: "true",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as AgentResult;
    assert.equal(body.taskId, "http-sync-1");
    assert.equal(body.status, "succeeded");
  });

  it("POST /v1/tasks/sync returns 422 on failure", async () => {
    const res = await fetch(url("/v1/tasks/sync"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-sync-fail",
        prompt: "will fail",
        testCommand: "false",
      }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as AgentResult;
    assert.equal(body.status, "failed");
  });

  it("GET unknown task → 404", async () => {
    const res = await fetch(url("/v1/tasks/does-not-exist"));
    assert.equal(res.status, 404);
  });
});
