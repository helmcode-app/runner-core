import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SessionStore,
  fromPersistedSession,
  parsePersistedSession,
  toPersistedSession,
} from "../../src/agent/index.js";
import { makeTempDir, removeTempDir, testLogger } from "../helpers.js";

const sample = {
  helmId: "11111111-1111-1111-1111-111111111111",
  cwd: "/app/main_repo",
  workspaceId: "default",
  title: "Fix tests",
  status: "running" as const,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:01:00.000Z",
  timeline: [
    {
      id: "user_1",
      at: "2026-08-14T00:00:30.000Z",
      kind: "message" as const,
      role: "user" as const,
      text: "hello",
      done: true,
    },
  ],
  checkpoints: [
    {
      messageId: "user_1",
      capturedAt: "2026-08-14T00:00:30.000Z",
      prompt: "hello",
    },
  ],
  availableModeIds: ["build"],
  configOptions: [],
};

describe("session persist", () => {
  it("drops running status and ACP-only fields on serialize", () => {
    const persisted = toPersistedSession(sample);
    assert.equal(persisted.version, 1);
    assert.equal(persisted.status, "idle");
    assert.equal(persisted.title, "Fix tests");
    const restored = fromPersistedSession(persisted);
    assert.equal(restored.status, "idle");
    assert.equal(restored.timeline.length, 1);
  });

  it("rejects malformed payloads", () => {
    assert.equal(parsePersistedSession(null), null);
    assert.equal(parsePersistedSession({ version: 1 }), null);
    assert.ok(parsePersistedSession(toPersistedSession(sample)));
  });

  it("round-trips through the disk store", async () => {
    const dir = await makeTempDir("helm-sessions-");
    try {
      const store = new SessionStore(dir, testLogger(), 1);
      store.schedule(sample);
      await store.flush();
      const loaded = await store.loadAll();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0]?.helmId, sample.helmId);
      assert.equal(loaded[0]?.status, "idle");
      assert.equal(loaded[0]?.title, "Fix tests");
      await store.remove(sample.helmId);
      const empty = await store.loadAll();
      assert.equal(empty.length, 0);
    } finally {
      await removeTempDir(dir);
    }
  });
});
