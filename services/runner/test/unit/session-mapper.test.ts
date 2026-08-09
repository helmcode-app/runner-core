import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapHistoryToTimeline,
  mapSession,
  mapSessionList,
} from "../../src/sessions/index.js";

describe("mapSession", () => {
  it("maps id and title", () => {
    const s = mapSession({ id: "ses_1", title: "Demo", status: "busy" });
    assert.equal(s.id, "ses_1");
    assert.equal(s.title, "Demo");
    assert.equal(s.status, "running");
  });

  it("accepts sessionID field", () => {
    const s = mapSession({ sessionID: "abc" });
    assert.equal(s.id, "abc");
  });
});

describe("mapSessionList", () => {
  it("maps arrays", () => {
    const list = mapSessionList([{ id: "a" }, { id: "b" }]);
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, "a");
  });
});

describe("mapHistoryToTimeline", () => {
  it("flattens OpenCode info/parts messages", () => {
    const entries = mapHistoryToTimeline([
      {
        info: { id: "m1", role: "user", time: { created: "2026-01-01T00:00:00Z" } },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { id: "m2", role: "assistant" },
        parts: [
          { type: "text", text: "world" },
          {
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "src/foo.ts" },
              title: "src/foo.ts",
              output: "…",
            },
          },
        ],
      },
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.role, "user");
    assert.equal(entries[0]?.text, "hello");
    assert.equal(entries[1]?.role, "assistant");
    // Answer text is primary; tools live in meta for Cursor-style cards.
    assert.equal(entries[1]?.text, "world");
    assert.deepEqual(entries[1]?.meta?.tools, ["Read src/foo.ts"]);
    const actions = entries[1]?.meta?.toolActions as
      | Array<{ name: string; path?: string; label: string }>
      | undefined;
    assert.equal(actions?.[0]?.name, "read");
    assert.equal(actions?.[0]?.path, "src/foo.ts");
  });

  it("skips empty step-only assistant messages", () => {
    const entries = mapHistoryToTimeline([
      {
        info: { id: "m1", role: "user" },
        parts: [{ type: "text", text: "hi" }],
      },
      {
        info: { id: "m2", role: "assistant" },
        parts: [
          { type: "step-start" },
          { type: "step-finish", reason: "stop" },
        ],
      },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, "m1");
  });

  it("marks assistant done only when time.completed / finish set", () => {
    const pending = mapHistoryToTimeline([
      {
        info: { id: "a1", role: "assistant", time: { created: 1 } },
        parts: [{ type: "text", text: "working…" }],
      },
    ]);
    assert.equal(pending[0]?.done, false);

    const finished = mapHistoryToTimeline([
      {
        info: {
          id: "a2",
          role: "assistant",
          finish: "stop",
          time: { created: 1, completed: 2 },
        },
        parts: [{ type: "text", text: "done" }],
      },
    ]);
    assert.equal(finished[0]?.done, true);
  });

  it("classifies reasoning vs answer vs tools", () => {
    const entries = mapHistoryToTimeline([
      {
        info: { id: "r1", role: "assistant", finish: "stop", time: { completed: 1 } },
        parts: [{ type: "reasoning", text: "I should check git status first" }],
      },
      {
        info: { id: "t1", role: "assistant", finish: "stop", time: { completed: 2 } },
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "git status" },
              output: "clean",
            },
          },
          {
            type: "patch",
            hash: "abc",
            files: ["src/a.ts", "src/b.ts"],
          },
        ],
      },
      {
        info: { id: "a1", role: "assistant", finish: "stop", time: { completed: 3 } },
        parts: [
          { type: "reasoning", text: "Looks clean" },
          { type: "text", text: "Rolled back the last edit." },
        ],
      },
    ]);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.kind, "reasoning");
    assert.equal(entries[0]?.meta?.reasoning, "I should check git status first");
    assert.equal(entries[1]?.kind, "tool");
    assert.deepEqual(entries[1]?.meta?.tools, [
      "Ran git status",
      "Edit src/a.ts",
      "Edit src/b.ts",
    ]);
    const actions = entries[1]?.meta?.toolActions as
      | Array<{ name: string; path?: string; content?: string }>
      | undefined;
    assert.equal(actions?.[0]?.name, "bash");
    assert.match(actions?.[0]?.content ?? "", /git status/);
    assert.match(actions?.[0]?.content ?? "", /clean/);
    assert.equal(actions?.[1]?.path, "src/a.ts");
    assert.equal(actions?.[2]?.path, "src/b.ts");
    assert.equal(entries[2]?.kind, "message");
    assert.equal(entries[2]?.text, "Rolled back the last edit.");
    assert.equal(entries[2]?.meta?.answer, "Rolled back the last edit.");
    assert.equal(entries[2]?.meta?.reasoning, "Looks clean");
  });

  it("includes edit path and content body", () => {
    const entries = mapHistoryToTimeline([
      {
        info: { id: "e1", role: "assistant", finish: "stop", time: { completed: 1 } },
        parts: [
          {
            type: "tool",
            tool: "edit",
            state: {
              status: "completed",
              input: {
                filePath: "pkg/hello.go",
                oldString: "foo",
                newString: "bar",
              },
              title: "pkg/hello.go",
              output: "ok",
            },
          },
        ],
      },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.meta?.tools?.[0], "Edit pkg/hello.go");
    const actions = entries[0]?.meta?.toolActions as
      | Array<{ path?: string; content?: string; label: string }>
      | undefined;
    assert.equal(actions?.[0]?.path, "pkg/hello.go");
    assert.match(actions?.[0]?.content ?? "", /^- foo$/m);
    assert.match(actions?.[0]?.content ?? "", /^\+ bar$/m);
  });

  it("does not emit patch:patch noise when files missing", () => {
    const entries = mapHistoryToTimeline([
      {
        info: { id: "p1", role: "assistant", finish: "stop", time: { completed: 1 } },
        parts: [{ type: "patch", hash: "x" }],
      },
    ]);
    // Empty shells are dropped entirely.
    assert.equal(entries.length, 0);
  });
});
