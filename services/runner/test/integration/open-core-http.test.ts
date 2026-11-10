import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  startOpenCore,
  type OpenCoreServer,
} from "../../src/modes/open-core/index.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
} from "../helpers.js";

describe("open-core HTTP API", () => {
  let root = "";
  let workspacesPath = "";
  let svc: OpenCoreServer | undefined;
  let apiToken = "";

  before(async () => {
    root = await makeTempDir("helm-http-");
    const fx = await createLocalGitFixture(root);
    workspacesPath = fx.workspacesPath;
    const config = testConfig({
      MAIN_REPO_PATH: fx.mainRepoPath,
      WORKSPACES_PATH: fx.workspacesPath,
      HOST: "127.0.0.1",
      PORT: "0",
    });
    svc = await startOpenCore(config, testLogger(), {
      installSignalHandlers: false,
    });
    const raw = JSON.parse(
      await readFile(
        path.join(workspacesPath, ".setup", "enrollments.json"),
        "utf8",
      ),
    ) as { bootstrap?: { code?: string } };
    assert.ok(raw.bootstrap?.code);
    const pub = await fetch(url("/v1/setup"));
    assert.equal(pub.status, 200);
    const pubBody = (await pub.json()) as {
      paired: boolean;
      authRequired: boolean;
      repo?: unknown;
    };
    assert.equal(pubBody.paired, false);
    assert.equal(pubBody.authRequired, true);
    assert.equal(pubBody.repo, undefined);
    const done = await fetch(url("/v1/setup/enroll"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: raw.bootstrap.code,
        deviceName: "Test iPad",
      }),
    });
    assert.equal(done.status, 200);
    const paired = (await done.json()) as {
      status: string;
      token: string;
      runnerId: string;
    };
    assert.equal(paired.status, "complete");
    apiToken = paired.token;
    assert.ok(apiToken);
    assert.ok(paired.runnerId);
  });

  after(async () => {
    await svc?.close();
    if (root) await removeTempDir(root);
  });

  function url(p: string): string {
    assert.ok(svc);
    return `${svc.baseUrl}${p}`;
  }

  function authHeaders(): HeadersInit {
    return apiToken ? { authorization: `Bearer ${apiToken}` } : {};
  }

  it("GET /health", async () => {
    const res = await fetch(url("/health"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      sessionsEnabled: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.mode, "open-core");
    assert.equal(body.sessionsEnabled, false);
  });

  it("GET /v1/status requires Bearer", async () => {
    const bare = await fetch(url("/v1/status"));
    assert.equal(bare.status, 401);
  });

  it("GET /v1/status", async () => {
    const res = await fetch(url("/v1/status"), { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      mode: string;
      sessionsEnabled: boolean;
      authRequired: boolean;
      setupPhase: string;
    };
    assert.equal(body.mode, "open-core");
    assert.equal(body.sessionsEnabled, false);
    assert.equal(body.authRequired, true);
    assert.equal(body.setupPhase, "ready");
  });

  it("GET /v1/sessions/* returns 503 when disabled", async () => {
    const res = await fetch(url("/v1/sessions/health"), {
      headers: authHeaders(),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /disabled/i);
  });

  it("GET /v1/agent shows catalog while sessions are off", async () => {
    const res = await fetch(url("/v1/agent"), { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      enabled: boolean;
      phase: string;
      source: string;
      harnesses: Array<{ id: string }>;
    };
    assert.equal(body.enabled, false);
    assert.equal(body.phase, "disabled");
    assert.equal(body.source, "none");
    assert.ok(body.harnesses.some((h) => h.id === "cursor"));
  });

  it("PUT /v1/agent can select a harness without enabling ACP", async () => {
    const res = await fetch(url("/v1/agent"), {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: false,
        harness: "claude",
        apiKey: "sk-ant-integration",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      enabled: boolean;
      harness: string;
      hasApiKey: boolean;
      phase: string;
    };
    assert.equal(body.enabled, false);
    assert.equal(body.harness, "claude");
    assert.equal(body.hasApiKey, true);
    assert.equal(body.phase, "disabled");

    const status = await fetch(url("/v1/status"), { headers: authHeaders() });
    assert.equal(status.status, 200);
    const statusBody = (await status.json()) as {
      sessionsEnabled: boolean;
      agentConfigured: boolean;
      agentHarness?: string;
    };
    assert.equal(statusBody.sessionsEnabled, false);
    assert.equal(statusBody.agentConfigured, false);
    assert.equal(statusBody.agentHarness, undefined);
  });

  it("PUT /v1/agent switches harness id while disabled", async () => {
    const res = await fetch(url("/v1/agent"), {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        enabled: false,
        harness: "codex",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      harness: string;
      hasApiKey: boolean;
    };
    assert.equal(body.harness, "codex");
    assert.equal(body.hasApiKey, true);
  });

  it("GET /v1/workspaces lists the primary workspace", async () => {
    const res = await fetch(url("/v1/workspaces"), { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      defaultWorkspaceId: string;
      workspaces: Array<{ id: string; kind: string; path: string }>;
    };
    assert.equal(body.defaultWorkspaceId, "default");
    assert.equal(body.workspaces.length, 1);
    assert.equal(body.workspaces[0]?.id, "default");
    assert.equal(body.workspaces[0]?.kind, "primary");
    assert.ok(body.workspaces[0]?.path);
  });

  it("unknown path → 404", async () => {
    const res = await fetch(url("/v1/tasks"), { headers: authHeaders() });
    assert.equal(res.status, 404);
  });
});
