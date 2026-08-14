import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapAcpSessionUpdate,
  mapStopReason,
  pickAcpModeId,
} from "../../src/agent/index.js";
import { resolvePermission } from "../../src/agent/permissions.js";

describe("mapAcpSessionUpdate", () => {
  it("maps agent_message_chunk to delta event", () => {
    const mapped = mapAcpSessionUpdate(
      {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
      { helmSessionId: "helm-1" },
    );
    assert.equal(mapped.events[0]?.type, "session.message.delta");
    assert.equal(mapped.events[0]?.sessionId, "helm-1");
    assert.ok(mapped.timelineUpserts[0]?.text.includes("hello"));
  });

  it("maps tool_call updates", () => {
    const mapped = mapAcpSessionUpdate({
      sessionId: "acp-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        status: "pending",
      },
    });
    assert.equal(mapped.events[0]?.type, "session.tool");
    assert.equal(mapped.timelineUpserts[0]?.kind, "tool");
    assert.equal(mapped.status, "running");
  });
});

describe("mapStopReason", () => {
  it("maps known stop reasons", () => {
    assert.equal(mapStopReason("end_turn"), "completed");
    assert.equal(mapStopReason("cancelled"), "cancelled");
    assert.equal(mapStopReason("refusal"), "failed");
  });
});

describe("pickAcpModeId", () => {
  it("returns undefined when agent advertised no modes", () => {
    assert.equal(pickAcpModeId("ask", []), undefined);
  });

  it("skips product ask when harness has no ask mode", () => {
    assert.equal(pickAcpModeId("ask", ["build", "plan"]), undefined);
  });

  it("maps agent to build when advertised", () => {
    assert.equal(pickAcpModeId("agent", ["build", "plan"]), "build");
  });

  it("honors mode overlay when present", () => {
    assert.equal(
      pickAcpModeId("agent", ["code", "plan"], { agent: "code" }),
      "code",
    );
  });
});

describe("resolvePermission", () => {
  it("auto-allows when policy=allow", () => {
    const res = resolvePermission("allow", {
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    assert.equal(res.outcome.outcome, "selected");
    if (res.outcome.outcome === "selected") {
      assert.equal(res.outcome.optionId, "allow-once");
    }
  });

  it("cancels when policy=deny", () => {
    const res = resolvePermission("deny", {
      options: [{ optionId: "allow-once", kind: "allow_once" }],
    });
    assert.equal(res.outcome.outcome, "cancelled");
  });
});
