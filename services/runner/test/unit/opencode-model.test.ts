import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeMode,
  parseModelRef,
  resolveModeMapping,
  toOpenCodeModelField,
} from "../../src/opencode/index.js";

describe("parseModelRef", () => {
  it("splits provider/model", () => {
    const ref = parseModelRef("anthropic/claude-sonnet-4-20250514");
    assert.deepEqual(ref, {
      raw: "anthropic/claude-sonnet-4-20250514",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    });
    assert.deepEqual(toOpenCodeModelField(ref), {
      providerID: "anthropic",
      modelID: "claude-sonnet-4-20250514",
    });
  });

  it("accepts bare model ids", () => {
    const ref = parseModelRef("gpt-4o");
    assert.equal(ref?.modelID, "gpt-4o");
    assert.equal(ref?.providerID, undefined);
    assert.equal(toOpenCodeModelField(ref), undefined);
  });

  it("returns undefined for empty", () => {
    assert.equal(parseModelRef(""), undefined);
    assert.equal(parseModelRef(null), undefined);
  });
});

describe("mode mapping", () => {
  it("normalizes mode strings", () => {
    assert.equal(normalizeMode("PLAN"), "plan");
    assert.equal(normalizeMode("ask"), "ask");
    assert.equal(normalizeMode("nope"), "agent");
  });

  it("maps plan/ask to agents with system preambles", () => {
    const plan = resolveModeMapping("plan");
    assert.equal(plan.agent, "plan");
    assert.ok(plan.systemPreamble?.includes("PLAN"));

    const ask = resolveModeMapping("ask");
    // ask maps to build + preamble (OpenCode often has no dedicated "ask" agent)
    assert.equal(ask.agent, "build");
    assert.ok(ask.systemPreamble?.includes("ASK"));

    const agent = resolveModeMapping("agent");
    assert.equal(agent.agent, "build");
    assert.equal(agent.systemPreamble, undefined);
  });

  it("honors env overrides", () => {
    const m = resolveModeMapping("agent", { agentName: "code" });
    assert.equal(m.agent, "code");
  });
});
