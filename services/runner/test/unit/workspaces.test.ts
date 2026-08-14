import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  parseWorkspaceId,
  WorkspaceNotFoundError,
  createWorkspaceRegistry,
} from "../../src/workspaces/index.js";
import { testConfig } from "../helpers.js";

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

describe("WorkspaceRegistry", () => {
  it("exposes the primary MAIN_REPO_PATH workspace", () => {
    const config = testConfig({ MAIN_REPO_PATH: "/tmp/main_repo" });
    const registry = createWorkspaceRegistry(config);
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "default");
    assert.equal(listed[0]?.kind, "primary");
    assert.equal(listed[0]?.path, "/tmp/main_repo");
    assert.equal(registry.get().path, "/tmp/main_repo");
  });

  it("rejects unknown ids", () => {
    const registry = createWorkspaceRegistry(testConfig());
    assert.throws(() => registry.get("other"), WorkspaceNotFoundError);
  });
});
