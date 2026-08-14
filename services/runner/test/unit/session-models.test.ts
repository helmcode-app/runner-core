import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearModelsCatalogCache,
  loadAgentModelsCatalog,
} from "../../src/agent/index.js";
import { loadConfig } from "../../src/config.js";

describe("agent models catalog", () => {
  it("advertises AGENT_DEFAULT_MODEL and connected provider", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go",
      AGENT_API_KEY: "k",
      AGENT_DEFAULT_MODEL: "opencode-go/glm-5.1",
    });
    const catalog = await loadAgentModelsCatalog(cfg, { forceRefresh: true });
    assert.ok(catalog.models.some((m) => m.id === "opencode-go/glm-5.1"));
    assert.deepEqual(catalog.connected, ["opencode-go"]);
    assert.equal(catalog.defaultModel, "opencode-go/glm-5.1");
  });

  it("includes extraModels from agent settings overlay", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-zen",
      AGENT_API_KEY: "k",
    });
    const catalog = await loadAgentModelsCatalog(cfg, {
      forceRefresh: true,
      settings: { extraModels: ["opencode/big-pickle", "opencode/other"] },
    });
    assert.ok(catalog.models.some((m) => m.id === "opencode/big-pickle"));
    assert.ok(catalog.models.some((m) => m.id === "opencode/other"));
    assert.deepEqual(catalog.connected, ["opencode"]);
  });

  it("advertises the implied vendor for a single-vendor harness", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_HARNESS: "claude",
      AGENT_API_KEY: "k",
      AGENT_DEFAULT_MODEL: "anthropic/claude-sonnet-4-6",
    });
    const catalog = await loadAgentModelsCatalog(cfg, { forceRefresh: true });
    assert.ok(catalog.models.some((m) => m.id === "anthropic/claude-sonnet-4-6"));
    assert.deepEqual(catalog.connected, ["anthropic"]);
    assert.equal(catalog.defaultModel, "anthropic/claude-sonnet-4-6");
  });
});
