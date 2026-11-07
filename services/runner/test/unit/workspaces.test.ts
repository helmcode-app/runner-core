import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  parseWorkspaceId,
  WorkspaceNotFoundError,
  createWorkspaceRegistry,
  workspaceIdForRepo,
} from "../../src/workspaces/index.js";
import { makeTempDir, removeTempDir, testConfig } from "../helpers.js";

describe("parseWorkspaceId", () => {
  it("defaults empty values to default", () => {
    assert.equal(parseWorkspaceId(undefined), DEFAULT_WORKSPACE_ID);
    assert.equal(parseWorkspaceId(""), DEFAULT_WORKSPACE_ID);
    assert.equal(parseWorkspaceId("  "), DEFAULT_WORKSPACE_ID);
  });

  it("trims explicit ids", () => {
    assert.equal(parseWorkspaceId(" task-1 "), "task-1");
  });
});

describe("workspaceIdForRepo", () => {
  it("builds a stable slug id", () => {
    assert.equal(workspaceIdForRepo("HelmCode", "App"), "helmcode--app");
    assert.equal(workspaceIdForRepo("a/b", "c d"), "a-b--c-d");
  });
});

describe("WorkspaceRegistry", () => {
  it("exposes the primary MAIN_REPO_PATH workspace", async () => {
    const config = testConfig({ MAIN_REPO_PATH: "/tmp/main_repo" });
    const registry = await createWorkspaceRegistry(config);
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "default");
    assert.equal(listed[0]?.kind, "primary");
    assert.equal(listed[0]?.path, "/tmp/main_repo");
    assert.equal(registry.get().path, "/tmp/main_repo");
  });

  it("rejects unknown ids", async () => {
    const registry = await createWorkspaceRegistry(testConfig());
    assert.throws(() => registry.get("other"), WorkspaceNotFoundError);
  });

  it("persists extra project workspaces", async () => {
    const root = await makeTempDir("helm-ws-");
    try {
      const config = testConfig({
        MAIN_REPO_PATH: `${root}/main`,
        WORKSPACES_PATH: `${root}/workspaces`,
      });
      const first = await createWorkspaceRegistry(config);
      const added = await first.addProject({
        path: `${root}/workspaces/projects/acme--api`,
        owner: "acme",
        repo: "api",
      });
      assert.equal(added.id, "acme--api");
      assert.equal(added.kind, "project");
      assert.equal(first.list().length, 2);

      const second = await createWorkspaceRegistry(config);
      assert.equal(second.list().length, 2);
      assert.equal(second.get("acme--api").path, added.path);
      assert.equal(second.findByRepo("Acme", "API")?.id, "acme--api");
    } finally {
      await removeTempDir(root);
    }
  });
});
