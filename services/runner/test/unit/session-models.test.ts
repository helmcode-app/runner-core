import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapProviderCatalog } from "../../src/sessions/models.js";

const sampleRaw = {
  connected: ["opencode", "opencode-go"],
  default: { opencode: "big-pickle", "opencode-go": "glm-5.1" },
  all: [
    {
      id: "opencode",
      name: "OpenCode Zen",
      models: {
        "big-pickle": { id: "big-pickle", name: "Big Pickle" },
        "mimo-v2.5-free": { id: "mimo-v2.5-free" },
      },
    },
    {
      id: "opencode-go",
      name: "OpenCode Go",
      models: {
        "glm-5.1": { name: "GLM-5.1" },
        "kimi-k2.5": { name: "Kimi K2.5" },
      },
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
      },
    },
  ],
};

describe("mapProviderCatalog", () => {
  it("filters to allowProviders when set (Go only)", () => {
    const out = mapProviderCatalog(sampleRaw, {
      allowProviders: ["opencode-go"],
    });
    assert.ok(out.models.every((m) => m.id.startsWith("opencode-go/")));
    assert.equal(out.models.length, 2);
    assert.deepEqual(out.connected, ["opencode-go"]);
    assert.equal(out.default, "opencode-go/glm-5.1");
  });

  it("filters to Zen only when allowProviders is opencode", () => {
    const out = mapProviderCatalog(sampleRaw, {
      allowProviders: ["opencode"],
    });
    assert.ok(out.models.every((m) => m.id.startsWith("opencode/")));
    assert.equal(out.models.length, 2);
    assert.equal(out.default, "opencode/big-pickle");
  });

  it("includes both when both are allowed", () => {
    const out = mapProviderCatalog(sampleRaw, {
      allowProviders: ["opencode-go", "opencode"],
    });
    assert.equal(out.models.length, 4);
    assert.ok(out.models.some((m) => m.id.startsWith("opencode-go/")));
    assert.ok(out.models.some((m) => m.id.startsWith("opencode/")));
  });

  it("falls back to OpenCode connected when no allow list", () => {
    const out = mapProviderCatalog(sampleRaw);
    assert.ok(out.models.every((m) => !m.id.startsWith("anthropic/")));
    assert.equal(out.models.length, 4);
  });

  it("includes all providers when connected is empty and no allow list", () => {
    const out = mapProviderCatalog({
      connected: [],
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "big-pickle": { name: "Big Pickle" } },
        },
      ],
    });
    assert.equal(out.models.length, 1);
    assert.equal(out.models[0]?.id, "opencode/big-pickle");
  });
});
