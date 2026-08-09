import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapProviderCatalog } from "../../src/sessions/models.js";

describe("mapProviderCatalog", () => {
  it("returns only connected providers", () => {
    const out = mapProviderCatalog({
      connected: ["opencode"],
      default: { opencode: "big-pickle", anthropic: "claude-sonnet-4-6" },
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": { id: "big-pickle", name: "Big Pickle" },
            "mimo-v2.5-free": { id: "mimo-v2.5-free" },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
          },
        },
        {
          id: "openai",
          name: "OpenAI",
          models: { "gpt-4o": { name: "GPT-4o" } },
        },
      ],
    });
    assert.equal(out.connected.length, 1);
    assert.ok(out.models.every((m) => m.id.startsWith("opencode/")));
    assert.equal(out.models.length, 2);
    assert.equal(out.default, "opencode/big-pickle");
    assert.ok(out.models.some((m) => m.id === "opencode/big-pickle"));
  });

  it("includes all providers when connected is empty", () => {
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
