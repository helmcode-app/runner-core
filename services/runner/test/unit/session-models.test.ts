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
    assert.deepEqual(catalog.connected, ["opencode-go", "opencode"]);
    assert.equal(catalog.defaultModel, "opencode-go/glm-5.1");
  });

  it("includes extraModels from agent settings overlay", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go-plus",
      AGENT_API_KEY: "k",
    });
    const catalog = await loadAgentModelsCatalog(cfg, {
      forceRefresh: true,
      settings: {
        extraModels: ["opencode-go/glm-5.2", "opencode-go/kimi-k2.6"],
      },
    });
    assert.ok(catalog.models.some((m) => m.id === "opencode-go/glm-5.2"));
    assert.ok(catalog.models.some((m) => m.id === "opencode-go/kimi-k2.6"));
    assert.deepEqual(catalog.connected, ["opencode-go", "opencode"]);
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

  it("merges harness-discovered models ahead of placeholders", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go",
      AGENT_API_KEY: "k",
      AGENT_DEFAULT_MODEL: "opencode-go/glm-5.1",
    });
    const catalog = await loadAgentModelsCatalog(cfg, {
      forceRefresh: true,
      discoveredModels: [
        "opencode-go/glm-5.1",
        "opencode-go/glm-5.2",
        "opencode-go/kimi-k2.6",
        "opencode/big-pickle",
      ],
    });
    const ids = catalog.models.map((m) => m.id);
    assert.deepEqual(
      ids.filter((id) =>
        [
          "opencode-go/glm-5.1",
          "opencode-go/glm-5.2",
          "opencode-go/kimi-k2.6",
          "opencode/big-pickle",
        ].includes(id),
      ),
      [
        "opencode-go/glm-5.1",
        "opencode-go/glm-5.2",
        "opencode-go/kimi-k2.6",
        "opencode/big-pickle",
      ],
    );
    assert.equal(catalog.defaultModel, "opencode-go/glm-5.1");
    assert.ok(catalog.models.length >= 4);
  });

  it("does not mix a stale OpenCode default into a Cursor catalog", async () => {
    clearModelsCatalogCache();
    const cfg = loadConfig({
      AGENT_HARNESS: "cursor",
      AGENT_API_KEY: "k",
      AGENT_DEFAULT_MODEL: "opencode-go/glm-5.1",
    });
    const catalog = await loadAgentModelsCatalog(cfg, {
      forceRefresh: true,
      discoveredModels: ["composer-2.5", "gpt-5.4"],
    });
    const ids = catalog.models.map((m) => m.id);
    assert.deepEqual(ids, ["composer-2.5", "gpt-5.4"]);
    assert.equal(catalog.defaultModel, "composer-2.5");
    assert.ok(!ids.includes("opencode-go/glm-5.1"));
  });
});
