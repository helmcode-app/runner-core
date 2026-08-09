import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startOpenCore, type OpenCoreServer } from "../../src/modes/open-core/index.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
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
      sessionsEnabled: boolean;
    };
    assert.equal(body.ok, true);
    assert.equal(body.mode, "open-core");
    assert.equal(body.sessionsEnabled, false);
  });

  it("GET /v1/status", async () => {
    const res = await fetch(url("/v1/status"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      mode: string;
      sessionsEnabled: boolean;
      authRequired: boolean;
    };
    assert.equal(body.mode, "open-core");
    assert.equal(body.sessionsEnabled, false);
    assert.equal(body.authRequired, false);
  });

  it("GET /v1/sessions/* returns 503 when disabled", async () => {
    const res = await fetch(url("/v1/sessions/health"));
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /disabled/i);
  });

  it("unknown path → 404", async () => {
    const res = await fetch(url("/v1/tasks"));
    assert.equal(res.status, 404);
  });
});

describe("open-core HTTP auth", () => {
  let root = "";
  let svc: OpenCoreServer | undefined;

  before(async () => {
    root = await makeTempDir("helm-http-auth-");
    const fx = await createLocalGitFixture(root);
    const config = testConfig({
      MAIN_REPO_PATH: fx.mainRepoPath,
      WORKSPACES_PATH: fx.workspacesPath,
      HOST: "127.0.0.1",
      PORT: "0",
      OPENCORE_API_TOKEN: "secret-token",
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

  it("GET /health stays open", async () => {
    const res = await fetch(url("/health"));
    assert.equal(res.status, 200);
  });

  it("GET /v1/status requires Bearer", async () => {
    const bare = await fetch(url("/v1/status"));
    assert.equal(bare.status, 401);

    const ok = await fetch(url("/v1/status"), {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(ok.status, 200);
  });
});
