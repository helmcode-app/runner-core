import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mapAcpSessionUpdate,
  mapStopReason,
  pickAcpModeId,
  usageFromPromptResult,
} from "../../src/agent/index.js";
import { resolvePermission } from "../../src/agent/permissions.js";
import {
  fastSetConfig,
  parseConfigOptions,
  thinkLevelSetConfig,
  modelIdsFromConfigOptions,
} from "../../src/agent/session-config.js";

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

  it("maps usage_update to session.usage", () => {
    const mapped = mapAcpSessionUpdate(
      {
        sessionId: "acp-1",
        update: {
          sessionUpdate: "usage_update",
          used: 53000,
          size: 200000,
          cost: { amount: 0.045, currency: "USD" },
        },
      },
      { helmSessionId: "helm-1" },
    );
    assert.equal(mapped.events[0]?.type, "session.usage");
    assert.deepEqual(mapped.usage, {
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" },
    });
    assert.deepEqual(mapped.events[0]?.data, mapped.usage);
  });

  it("maps config_option_update", () => {
    const mapped = mapAcpSessionUpdate({
      sessionId: "acp-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            id: "thought",
            type: "select",
            name: "Think",
            category: "thought_level",
            currentValue: "medium",
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
            ],
          },
        ],
      },
    });
    assert.equal(mapped.events[0]?.type, "session.config");
    assert.equal(mapped.configOptions?.[0]?.id, "thought");
    assert.equal(mapped.configOptions?.[0]?.type, "select");
  });
});

describe("session config mapping", () => {
  const options = parseConfigOptions([
    {
      id: "thought",
      type: "select",
      name: "Think Level",
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
      ],
    },
    {
      id: "fast",
      type: "boolean",
      name: "Fast",
      category: "model_config",
      currentValue: false,
    },
  ]);

  it("maps thinkLevel onto thought_level select", () => {
    assert.deepEqual(thinkLevelSetConfig(options, "high"), {
      configId: "thought",
      value: "high",
    });
  });

  it("maps xhigh aliases onto extra-high values", () => {
    const extra = parseConfigOptions([
      {
        id: "thought",
        type: "select",
        category: "thought_level",
        name: "Think",
        currentValue: "medium",
        options: [{ value: "extra-high", name: "Extra High" }],
      },
    ]);
    assert.deepEqual(thinkLevelSetConfig(extra, "xhigh"), {
      configId: "thought",
      value: "extra-high",
    });
  });

  it("maps fast onto boolean model_config", () => {
    assert.deepEqual(fastSetConfig(options, true), {
      configId: "fast",
      type: "boolean",
      value: true,
    });
  });

  it("extracts provider/model ids from configOptions", () => {
    const options = parseConfigOptions([
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "opencode-go/glm-5.1",
        options: [
          { value: "opencode-go/glm-5.1", name: "glm-5.1" },
          {
            group: "go",
            name: "Go",
            options: [{ value: "opencode-go/glm-5.2", name: "glm-5.2" }],
          },
        ],
      },
    ]);
    assert.deepEqual(modelIdsFromConfigOptions(options), [
      "opencode-go/glm-5.1",
      "opencode-go/glm-5.2",
    ]);
  });

  it("maps thinkLevel onto OpenCode effort option", () => {
    const effort = parseConfigOptions([
      {
        id: "effort",
        type: "select",
        name: "Effort",
        category: "thought_level",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "max", name: "Max" },
        ],
      },
    ]);
    assert.deepEqual(thinkLevelSetConfig(effort, "xhigh"), {
      configId: "effort",
      value: "max",
    });
  });
});

describe("usageFromPromptResult", () => {
  it("maps experimental PromptResponse.usage onto used/size", () => {
    assert.deepEqual(
      usageFromPromptResult({
        usage: { inputTokens: 1200, cachedReadTokens: 800, totalTokens: 2500 },
      }),
      { used: 2000, size: 200000 },
    );
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
