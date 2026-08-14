import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatSeedContext,
  parseRewindRestore,
  planRewind,
  type SessionCheckpoint,
} from "../../src/agent/rewind.js";
import { AgentRuntimeError } from "../../src/agent/errors.js";
import type { TimelineEntry } from "../../src/sessions/types.js";

function user(id: string, text: string): TimelineEntry {
  return { id, kind: "message", role: "user", text, done: true };
}

function assistant(id: string, text: string): TimelineEntry {
  return { id, kind: "message", role: "assistant", text, done: true };
}

describe("parseRewindRestore", () => {
  it("defaults to both", () => {
    assert.equal(parseRewindRestore(undefined), "both");
    assert.equal(parseRewindRestore(""), "both");
  });

  it("accepts known values", () => {
    assert.equal(parseRewindRestore("conversation"), "conversation");
    assert.equal(parseRewindRestore("code"), "code");
  });

  it("rejects unknown values", () => {
    assert.throws(() => parseRewindRestore("files"), AgentRuntimeError);
  });
});

describe("planRewind", () => {
  const timeline: TimelineEntry[] = [
    user("user_1", "first"),
    assistant("a_1", "ok"),
    user("user_2", "second"),
    assistant("a_2", "done"),
  ];
  const checkpoints: SessionCheckpoint[] = [
    { messageId: "user_1", capturedAt: "t1", prompt: "first", tree: "aaa" },
    { messageId: "user_2", capturedAt: "t2", prompt: "second", tree: "bbb" },
  ];

  it("keeps turns before the target user message", () => {
    const plan = planRewind(timeline, checkpoints, "user_2");
    assert.equal(plan.kept.length, 2);
    assert.equal(plan.kept[0]?.id, "user_1");
    assert.equal(plan.removed.length, 2);
    assert.equal(plan.checkpoint.tree, "bbb");
    assert.deepEqual(
      plan.keptCheckpoints.map((c) => c.messageId),
      ["user_1"],
    );
  });

  it("rejects missing or non-user targets", () => {
    assert.throws(() => planRewind(timeline, checkpoints, "nope"), /not found/);
    assert.throws(() => planRewind(timeline, checkpoints, "a_1"), /user message/);
    assert.throws(
      () => planRewind(timeline, [], "user_1"),
      /no checkpoint/,
    );
  });
});

describe("formatSeedContext", () => {
  it("returns undefined when there is no dialogue", () => {
    assert.equal(formatSeedContext([]), undefined);
  });

  it("formats prior user/assistant turns", () => {
    const text = formatSeedContext([
      user("user_1", "hello"),
      assistant("a_1", "hi"),
    ]);
    assert.match(text ?? "", /User:\nhello/);
    assert.match(text ?? "", /Assistant:\nhi/);
  });
});
