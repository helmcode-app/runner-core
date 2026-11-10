import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextLevelsFromConfigOptions,
  modelEntriesFromConfigOptions,
  parseConfigOptions,
  parseContextTokens,
  parseModelCapabilityKeys,
  stripModelDecoration,
  supportsFastFromConfigOptions,
  thinkingLevelsFromConfigOptions,
  thinkLevelsFromConfigOptions,
  type HelmConfigOption,
} from "../../src/agent/session-config.js";
import {
  clearModelsCatalogCache,
  loadAgentModelsCatalog,
} from "../../src/agent/index.js";
import { loadConfig } from "../../src/config.js";

describe("harness think/fast capability discovery", () => {
  it("maps product think levels from ACP thought_level values", () => {
    const options: HelmConfigOption[] = [
      {
        id: "thought_level",
        type: "select",
        name: "Thought Level",
        category: "thought_level",
        values: ["low", "medium", "high", "xhigh"],
      },
    ];
    assert.deepEqual(thinkLevelsFromConfigOptions(options), [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("returns empty think levels when harness has no thought option", () => {
    const options: HelmConfigOption[] = [
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        values: ["opencode-go/glm-5.1"],
      },
    ];
    assert.deepEqual(thinkLevelsFromConfigOptions(options), []);
  });

  it("surfaces unfamiliar think labels as-is", () => {
    const options: HelmConfigOption[] = [
      {
        id: "effort",
        type: "select",
        name: "Reasoning Effort",
        values: ["fast", "careful"],
      },
    ];
    assert.deepEqual(thinkLevelsFromConfigOptions(options), ["fast", "careful"]);
  });

  it("prefers effort ladder over thinking on/off toggle", () => {
    const options = parseConfigOptions([
      {
        id: "thinking",
        type: "select",
        name: "Thinking",
        category: "thought_level",
        currentValue: "true",
        options: [
          { value: "false", name: "Off" },
          { value: "true", name: "On" },
        ],
      },
      {
        id: "effort",
        type: "select",
        name: "Effort",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra High" },
          { value: "max", name: "Max" },
        ],
      },
    ]);
    assert.deepEqual(thinkLevelsFromConfigOptions(options), [
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    assert.deepEqual(thinkingLevelsFromConfigOptions(options), [
      "false",
      "true",
    ]);
  });

  it("detects boolean and select fast options", () => {
    assert.equal(
      supportsFastFromConfigOptions([
        { id: "fast", type: "boolean", name: "Fast", category: "fast" },
      ]),
      true,
    );
    assert.equal(
      supportsFastFromConfigOptions([
        {
          id: "fast",
          type: "select",
          name: "Fast Mode",
          values: ["on", "off"],
        },
      ]),
      true,
    );
    assert.equal(
      supportsFastFromConfigOptions([
        {
          id: "model",
          type: "select",
          name: "Model",
          values: ["a/b"],
        },
      ]),
      false,
    );
  });

  it("extracts context levels", () => {
    const options = parseConfigOptions([
      {
        id: "context",
        type: "select",
        name: "Context",
        category: "model_config",
        currentValue: "200k",
        options: [
          { value: "200k", name: "200K" },
          { value: "1m", name: "1M" },
        ],
      },
    ]);
    assert.deepEqual(contextLevelsFromConfigOptions(options), ["200k", "1m"]);
    assert.equal(parseContextTokens("200k"), 200_000);
    assert.equal(parseContextTokens("1m"), 1_000_000);
    assert.equal(parseContextTokens("272k"), 272_000);
  });

  it("cleans Cursor-style model decorations and capability tags", () => {
    assert.equal(
      stripModelDecoration(
        "claude-opus-5[context,reasoning_effort/effort/fast,thinking]",
      ),
      "claude-opus-5",
    );
    assert.deepEqual(
      parseModelCapabilityKeys(
        "Claude Opus 5[context,reasoning_effort/effort/fast,thinking]",
      ),
      ["context", "reasoning_effort", "effort", "fast", "thinking"],
    );

    const options = parseConfigOptions([
      {
        id: "model",
        type: "select",
        name: "Model",
        category: "model",
        currentValue: "claude-opus-5[thinking=true,context=300k]",
        options: [
          {
            value: "claude-opus-5[thinking=true,context=300k]",
            name: "Claude Opus 5[context,reasoning_effort/effort/fast,thinking]",
          },
          {
            value: "composer-2.5[fast=true]",
            name: "Composer 2.5[fast]",
          },
          {
            value: "claude-opus-5[thinking=false,context=1m]",
            name: "Claude Opus 5[context,thinking]",
          },
        ],
      },
    ]);
    const entries = modelEntriesFromConfigOptions(options);
    assert.deepEqual(
      entries.map((e) => ({ id: e.id, name: e.name })),
      [
        { id: "claude-opus-5", name: "Claude Opus 5" },
        { id: "composer-2.5", name: "Composer 2.5" },
      ],
    );
    assert.deepEqual(entries[0]?.capabilityKeys.sort(), [
      "context",
      "effort",
      "fast",
      "reasoning_effort",
      "thinking",
    ]);
  });

  it("includes thinkLevels and supportsFast on models catalog", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go",
      AGENT_API_KEY: "k",
      AGENT_DEFAULT_MODEL: "opencode-go/glm-5.1",
    });
    const withCaps = await loadAgentModelsCatalog(cfg, {
      forceRefresh: true,
      thinkLevels: ["low", "medium", "high"],
      thinkingLevels: ["false", "true"],
      contextLevels: ["200k", "1m"],
      supportsFast: true,
      discoveredModels: [
        {
          id: "claude-opus-5",
          wireValue: "claude-opus-5[thinking=true]",
          name: "Claude Opus 5",
          capabilityKeys: ["thinking"],
        },
      ],
    });
    assert.deepEqual(withCaps.thinkLevels, ["low", "medium", "high"]);
    assert.deepEqual(withCaps.thinkingLevels, ["false", "true"]);
    assert.deepEqual(withCaps.contextLevels, ["200k", "1m"]);
    assert.equal(withCaps.supportsFast, true);
    assert.equal(withCaps.models[0]?.id, "claude-opus-5");
    assert.equal(withCaps.models[0]?.name, "Claude Opus 5");

    clearModelsCatalogCache();
    const withoutCaps = await loadAgentModelsCatalog(cfg, {
      forceRefresh: true,
    });
    assert.equal(withoutCaps.thinkLevels, undefined);
    assert.equal(withoutCaps.supportsFast, false);
  });
});
