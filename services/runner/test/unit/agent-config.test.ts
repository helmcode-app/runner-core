import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import path from "node:path";
import {
  agentConfigFromEnv,
  createAgentRuntimeController,
  effectiveAppConfig,
  loadPersistedAgentConfig,
  mergeAgentConfigUpdate,
  parsePersistedAgentConfig,
  redactApiKey,
  savePersistedAgentConfig,
  validateAgentConfig,
} from "../../src/agent/index.js";
import {
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
} from "../helpers.js";

describe("agent config store", () => {
  it("parses a valid agent.json shape", () => {
    const parsed = parsePersistedAgentConfig({
      version: 1,
      enabled: true,
      harness: "claude",
      apiKey: " sk-ant ",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.ok(parsed);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.harness, "claude");
    assert.equal(parsed.apiKey, "sk-ant");
  });

  it("rejects unknown harness / provider", () => {
    assert.equal(
      parsePersistedAgentConfig({
        version: 1,
        enabled: true,
        harness: "nope",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      null,
    );
  });

  it("requires provider when enabling OpenCode", () => {
    assert.match(
      validateAgentConfig({
        version: 1,
        enabled: true,
        harness: "opencode",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }) ?? "",
      /provider/i,
    );
    assert.match(
      validateAgentConfig({
        version: 1,
        enabled: true,
        harness: "opencode",
        provider: "opencode-go",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }) ?? "",
      /apiKey/i,
    );
    assert.equal(
      validateAgentConfig({
        version: 1,
        enabled: true,
        harness: "opencode",
        provider: "opencode-go",
        apiKey: "k",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      null,
    );
  });

  it("normalizes legacy provider aliases on merge", () => {
    const next = mergeAgentConfigUpdate(null, {
      enabled: true,
      harness: "opencode",
      provider: "opencode" as never,
      apiKey: "k",
    });
    assert.equal(next.provider, "opencode-go");
  });

  it("keeps previous apiKey when update omits it", () => {
    const next = mergeAgentConfigUpdate(
      {
        version: 1,
        enabled: true,
        harness: "claude",
        apiKey: "keep-me",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { enabled: true, harness: "codex" },
    );
    assert.equal(next.harness, "codex");
    assert.equal(next.apiKey, "keep-me");
  });

  it("drops defaultModel when switching harness", () => {
    const next = mergeAgentConfigUpdate(
      {
        version: 1,
        enabled: true,
        harness: "opencode",
        provider: "opencode-go",
        defaultModel: "opencode-go/glm-5.1",
        apiKey: "k",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { enabled: true, harness: "cursor", apiKey: "cursor-key" },
    );
    assert.equal(next.harness, "cursor");
    assert.equal(next.defaultModel, undefined);
  });

  it("sanitizes a foreign defaultModel for the current harness", async () => {
    const { sanitizePersistedAgentConfig } = await import(
      "../../src/agent/config-store.js"
    );
    const cleaned = sanitizePersistedAgentConfig({
      version: 1,
      enabled: true,
      harness: "cursor",
      apiKey: "cursor-key",
      defaultModel: "opencode-go/glm-5.1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(cleaned.defaultModel, undefined);
  });

  it("clears apiKey when update sends empty string", () => {
    const next = mergeAgentConfigUpdate(
      {
        version: 1,
        enabled: true,
        harness: "claude",
        apiKey: "old",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { enabled: true, harness: "claude", apiKey: "  " },
    );
    assert.equal(next.apiKey, undefined);
  });

  it("redacts api keys for client views", () => {
    assert.deepEqual(redactApiKey(undefined), { hasApiKey: false });
    assert.equal(redactApiKey("sk-ant-abcdef").hasApiKey, true);
    assert.equal(redactApiKey("sk-ant-abcdef").apiKeyHint, "••••cdef");
  });

  it("maps env bootstrap into a selection", () => {
    const cfg = testConfig({
      SESSIONS_ENABLED: "true",
      AGENT_HARNESS: "cursor",
      AGENT_API_KEY: "cursor-key",
    });
    const fromEnv = agentConfigFromEnv(cfg);
    assert.ok(fromEnv);
    assert.equal(fromEnv.harness, "cursor");
    assert.equal(fromEnv.apiKey, "cursor-key");
    assert.equal(effectiveAppConfig(cfg, fromEnv).SESSIONS_ENABLED, true);
  });

  it("round-trips agent.json on disk", async () => {
    const root = await makeTempDir("helm-agent-cfg-");
    try {
      const file = path.join(root, "agent.json");
      await savePersistedAgentConfig(file, {
        version: 1,
        enabled: false,
        harness: "grok",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const loaded = await loadPersistedAgentConfig(file);
      assert.ok(loaded);
      assert.equal(loaded.harness, "grok");
      assert.equal(loaded.enabled, false);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe("agent runtime controller", () => {
  let root = "";

  before(async () => {
    root = await makeTempDir("helm-agent-ctrl-");
  });

  after(async () => {
    if (root) await removeTempDir(root);
  });

  it("boots disabled with no file and no env", async () => {
    const cfg = testConfig({ WORKSPACES_PATH: root });
    const agent = createAgentRuntimeController(cfg, testLogger(), {
      configPath: path.join(root, "agent.json"),
    });
    await agent.boot();
    const view = agent.view();
    assert.equal(view.enabled, false);
    assert.equal(view.phase, "disabled");
    assert.equal(view.source, "none");
    assert.equal(agent.gateway, null);
    assert.ok(view.harnesses.some((h) => h.id === "claude"));
  });

  it("persists selection and can switch harness while disabled", async () => {
    const cfg = testConfig({ WORKSPACES_PATH: root });
    const configPath = path.join(root, "switch-agent.json");
    const agent = createAgentRuntimeController(cfg, testLogger(), {
      configPath,
    });
    await agent.boot();

    let view = await agent.apply({
      enabled: false,
      harness: "claude",
      apiKey: "sk-ant-test",
    });
    assert.equal(view.enabled, false);
    assert.equal(view.harness, "claude");
    assert.equal(view.hasApiKey, true);
    assert.equal(view.source, "file");
    assert.equal(agent.gateway, null);

    view = await agent.apply({
      enabled: false,
      harness: "codex",
    });
    assert.equal(view.harness, "codex");
    assert.equal(view.hasApiKey, true, "api key kept across harness switch");

    const loaded = await loadPersistedAgentConfig(configPath);
    assert.ok(loaded);
    assert.equal(loaded.harness, "codex");
    assert.equal(loaded.apiKey, "sk-ant-test");
  });

  it("rejects enabling OpenCode without provider", async () => {
    const cfg = testConfig({ WORKSPACES_PATH: root });
    const agent = createAgentRuntimeController(cfg, testLogger(), {
      configPath: path.join(root, "bad-opencode.json"),
    });
    await agent.boot();
    await assert.rejects(
      () =>
        agent.apply({
          enabled: true,
          harness: "opencode",
          apiKey: "oc-key",
        }),
      /provider/i,
    );
  });
});
