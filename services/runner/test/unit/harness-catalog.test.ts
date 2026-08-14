import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_HARNESS_IDS,
  childAuthEnv,
  connectedProviderIds,
  createHarnessRuntime,
  harnessNeedsProvider,
  harnessSpec,
  resolveStdioHarnessSettings,
} from "../../src/agent/index.js";
import { loadConfig } from "../../src/config.js";
import { testLogger } from "../helpers.js";

describe("harness catalog", () => {
  it("lists supported AGENT_HARNESS ids", () => {
    assert.deepEqual([...AGENT_HARNESS_IDS], [
      "opencode",
      "claude",
      "codex",
      "cursor",
      "grok",
    ]);
  });

  it("requires AGENT_PROVIDER only for multi-provider shells", () => {
    assert.equal(harnessNeedsProvider("opencode"), true);
    assert.equal(harnessNeedsProvider("claude"), false);
    assert.equal(harnessNeedsProvider("codex"), false);
    assert.equal(harnessNeedsProvider("cursor"), false);
    assert.equal(harnessNeedsProvider("grok"), false);
  });

  it("uses auth.json for OpenCode and env keys for single-vendor", () => {
    assert.equal(harnessSpec("opencode").auth, "opencode-json");
    assert.equal(harnessSpec("claude").auth, "env");
    assert.equal(harnessSpec("codex").auth, "env");
    assert.deepEqual(harnessSpec("codex").apiKeyAliases, ["OPENAI_API_KEY"]);
  });

  it("maps single-vendor keys to the product env var", () => {
    const cfg = loadConfig({
      AGENT_HARNESS: "claude",
      AGENT_API_KEY: "sk-ant-test",
    });
    const env = childAuthEnv(cfg, harnessSpec("claude"));
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
    assert.equal(env.CODEX_API_KEY, undefined);
  });

  it("sets Codex key and disables browser login", () => {
    const cfg = loadConfig({
      AGENT_HARNESS: "codex",
      AGENT_API_KEY: "sk-codex",
    });
    const env = childAuthEnv(cfg, harnessSpec("codex"));
    assert.equal(env.CODEX_API_KEY, "sk-codex");
    assert.equal(env.OPENAI_API_KEY, "sk-codex");
    assert.equal(env.NO_BROWSER, "1");
  });

  it("resolves stdio install prefix from the harness id", () => {
    const settings = resolveStdioHarnessSettings(harnessSpec("claude"), {
      prefix: "/data/claude",
    });
    assert.equal(settings.prefix, "/data/claude");
    assert.equal(settings.packageName, "@agentclientprotocol/claude-agent-acp");
    assert.deepEqual(settings.args, []);
  });

  it("createHarnessRuntime selects every catalog harness through stdio", () => {
    for (const id of AGENT_HARNESS_IDS) {
      const cfg = loadConfig({
        SESSIONS_ENABLED: "true",
        AGENT_HARNESS: id,
        AGENT_API_KEY: "k",
        ...(id === "opencode" ? { AGENT_PROVIDER: "opencode-go" } : {}),
      });
      const runtime = createHarnessRuntime(cfg, testLogger());
      assert.ok(runtime, id);
      assert.equal(runtime.status.harness, id);
      assert.equal(runtime.status.transport, "stdio");
      assert.ok(runtime.modes.agent);
    }
  });
});

describe("connected providers", () => {
  it("uses OpenCode AGENT_PROVIDER when harness is opencode", () => {
    const cfg = loadConfig({
      AGENT_HARNESS: "opencode",
      AGENT_PROVIDER: "opencode-go",
      AGENT_API_KEY: "k",
    });
    assert.deepEqual(connectedProviderIds(cfg), ["opencode-go"]);
  });

  it("uses the implied vendor when harness is single-vendor", () => {
    const cfg = loadConfig({
      AGENT_HARNESS: "grok",
      AGENT_API_KEY: "xai-k",
    });
    assert.deepEqual(connectedProviderIds(cfg), ["xai"]);
  });

  it("does not require AGENT_PROVIDER for claude", () => {
    const cfg = loadConfig({
      SESSIONS_ENABLED: "true",
      AGENT_HARNESS: "claude",
      AGENT_API_KEY: "sk-ant",
    });
    assert.equal(cfg.AGENT_PROVIDER, undefined);
    assert.deepEqual(connectedProviderIds(cfg), ["anthropic"]);
  });
});
