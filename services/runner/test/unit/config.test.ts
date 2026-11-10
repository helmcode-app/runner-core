import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults for open-core", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.mode, "open-core");
    assert.equal(cfg.HELM_MODE, "open-core");
    assert.equal(cfg.PORT, 8080);
    assert.equal(cfg.MAIN_REPO_PATH, "/app/main_repo");
    assert.equal(cfg.SESSIONS_ENABLED, false);
    assert.equal(cfg.AGENT_HARNESS, "opencode");
    assert.equal(cfg.VFS_ENABLED, true);
  });

  it("parses numeric env coercions", () => {
    const cfg = loadConfig({
      PORT: "9090",
    });
    assert.equal(cfg.PORT, 9090);
  });

  it("allows ephemeral PORT=0", () => {
    const cfg = loadConfig({ PORT: "0" });
    assert.equal(cfg.PORT, 0);
  });

  it("rejects commercial-saas mode (removed)", () => {
    assert.throws(
      () =>
        loadConfig({
          HELM_MODE: "commercial-saas",
        }),
      /Invalid environment configuration/,
    );
  });

  it("rejects invalid LOG_LEVEL", () => {
    assert.throws(
      () =>
        loadConfig({
          LOG_LEVEL: "verbose",
        }),
      /Invalid environment configuration/,
    );
  });

  it("treats empty strings as unset", () => {
    const cfg = loadConfig({
      AGENT_DEFAULT_MODEL: "",
      AGENT_API_KEY: "",
    });
    assert.equal(cfg.AGENT_DEFAULT_MODEL, undefined);
    assert.equal(cfg.AGENT_API_KEY, undefined);
    // OpenCode harness defaults provider to opencode-go even when unset.
    assert.equal(cfg.AGENT_PROVIDER, "opencode-go");
  });

  it("defaults AGENT_PROVIDER for OpenCode without requiring env", () => {
    const cfg = loadConfig({ AGENT_HARNESS: "opencode", AGENT_API_KEY: "k" });
    assert.equal(cfg.AGENT_PROVIDER, "opencode-go");
  });

  it("parses AGENT_PROVIDER + AGENT_API_KEY", () => {
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go-plus",
      AGENT_API_KEY: "secret",
      AGENT_DEFAULT_MODEL: "opencode-go/glm-5.1",
    });
    assert.equal(cfg.AGENT_PROVIDER, "opencode-go");
    assert.equal(cfg.AGENT_API_KEY, "secret");
    assert.equal(cfg.AGENT_DEFAULT_MODEL, "opencode-go/glm-5.1");
  });

  it("rejects unknown AGENT_PROVIDER", () => {
    assert.throws(
      () =>
        loadConfig({
          AGENT_PROVIDER: "anthropic",
        }),
      /Invalid environment configuration/,
    );
  });

  it("accepts single-vendor AGENT_HARNESS without AGENT_PROVIDER", () => {
    const cfg = loadConfig({
      AGENT_HARNESS: "cursor",
      AGENT_API_KEY: "cursor-k",
    });
    assert.equal(cfg.AGENT_HARNESS, "cursor");
    assert.equal(cfg.AGENT_PROVIDER, undefined);
    assert.equal(cfg.AGENT_API_KEY, "cursor-k");
  });

  it("rejects unknown AGENT_HARNESS", () => {
    assert.throws(
      () =>
        loadConfig({
          AGENT_HARNESS: "goose",
        }),
      /Invalid environment configuration/,
    );
  });

  it("normalizes REVIEW_SETUP_CODE", () => {
    const cfg = loadConfig({ REVIEW_SETUP_CODE: "abcdefgh" });
    assert.equal(cfg.REVIEW_SETUP_CODE, "ABCD-EFGH");
  });

  it("rejects invalid REVIEW_SETUP_CODE", () => {
    assert.throws(
      () => loadConfig({ REVIEW_SETUP_CODE: "too-short" }),
      /Invalid REVIEW_SETUP_CODE/,
    );
  });

  it("normalizes legacy opencode provider to opencode-go", () => {
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode",
      AGENT_DEFAULT_MODEL: "opencode/beam-free",
    });
    assert.equal(cfg.AGENT_PROVIDER, "opencode-go");
    assert.equal(cfg.AGENT_DEFAULT_MODEL, "opencode/beam-free");
  });
});
