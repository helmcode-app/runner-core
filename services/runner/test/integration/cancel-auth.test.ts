import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AgentResult } from "../../src/types.js";
import { startOpenCore, type OpenCoreServer } from "../../src/modes/open-core/index.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
  waitFor,
} from "../helpers.js";

describe("open-core auth + cancel", () => {
  let root = "";
  let svc: OpenCoreServer | undefined;
  const token = "test-secret-token";

  before(async () => {
    root = await makeTempDir("helm-auth-");
    const fx = await createLocalGitFixture(root);
    const config = testConfig({
      MAIN_REPO_PATH: fx.mainRepoPath,
      WORKSPACES_PATH: fx.workspacesPath,
      HOST: "127.0.0.1",
      PORT: "0",
      GITHUB_TOKEN: "test-token-local",
      OPENCORE_API_TOKEN: token,
      TASK_TIMEOUT_MS: "0",
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

  function authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
  }

  it("GET /health is public", async () => {
    const res = await fetch(url("/health"));
    assert.equal(res.status, 200);
  });

  it("protected routes return 401 without token", async () => {
    const status = await fetch(url("/v1/status"));
    assert.equal(status.status, 401);

    const tasks = await fetch(url("/v1/tasks"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x", testCommand: "true" }),
    });
    assert.equal(tasks.status, 401);
  });

  it("accepts Bearer token on /v1/status", async () => {
    const res = await fetch(url("/v1/status"), {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { authRequired: boolean };
    assert.equal(body.authRequired, true);
  });

  it("cancels a long-running task", async () => {
    const submit = await fetch(url("/v1/tasks"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        id: "cancel-me",
        prompt: "sleep then cancel",
        testCommand: "sleep 30",
      }),
    });
    assert.equal(submit.status, 202);

    // Give the pipeline a moment to enter the test step.
    await new Promise((r) => setTimeout(r, 80));

    const cancel = await fetch(url("/v1/tasks/cancel-me/cancel"), {
      method: "POST",
      headers: authHeaders(),
    });
    assert.equal(cancel.status, 202);

    const final = await waitFor(async () => {
      const res = await fetch(url("/v1/tasks/cancel-me"), {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as {
        status: string;
        result: AgentResult | null;
      };
      if (body.result) return body;
      return null;
    }, { timeoutMs: 10_000 });

    assert.equal(final.status, "cancelled");
    assert.equal(final.result?.status, "cancelled");
  });

  it("hard-times out a long task via timeoutMs", async () => {
    const res = await fetch(url("/v1/tasks/sync"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        id: "timeout-me",
        prompt: "will time out",
        testCommand: "sleep 30",
        timeoutMs: 200,
      }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as AgentResult;
    assert.equal(body.status, "cancelled");
    assert.match(body.error ?? "", /timed out/i);
  });
});
