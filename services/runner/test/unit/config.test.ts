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
      OPENCORE_API_TOKEN: "",
      AGENT_DEFAULT_MODEL: "",
      AGENT_API_KEY: "",
    });
    assert.equal(cfg.OPENCORE_API_TOKEN, undefined);
    assert.equal(cfg.AGENT_DEFAULT_MODEL, undefined);
    assert.equal(cfg.AGENT_API_KEY, undefined);
    assert.equal(cfg.AGENT_PROVIDER, undefined);
  });

  it("parses AGENT_PROVIDER + AGENT_API_KEY", () => {
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-zen",
      AGENT_API_KEY: "secret",
      AGENT_DEFAULT_MODEL: "opencode/big-pickle",
    });
    assert.equal(cfg.AGENT_PROVIDER, "opencode-zen");
    assert.equal(cfg.AGENT_API_KEY, "secret");
    assert.equal(cfg.AGENT_DEFAULT_MODEL, "opencode/big-pickle");
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
});
