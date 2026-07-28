import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults for open-core", () => {
    const cfg = loadConfig({
      GIT_USER_EMAIL: "agent@helmcode.app",
    });
    assert.equal(cfg.mode, "open-core");
    assert.equal(cfg.HELM_MODE, "open-core");
    assert.equal(cfg.PORT, 8080);
    assert.equal(cfg.MAIN_REPO_PATH, "/app/main_repo");
    assert.equal(cfg.MAX_TEST_RETRIES, 3);
    assert.equal(cfg.DEFAULT_BASE_BRANCH, "main");
  });

  it("parses numeric env coercions", () => {
    const cfg = loadConfig({
      PORT: "9090",
      MAX_TEST_RETRIES: "5",
      POLL_INTERVAL_MS: "1500",
      GIT_USER_EMAIL: "agent@helmcode.app",
    });
    assert.equal(cfg.PORT, 9090);
    assert.equal(cfg.MAX_TEST_RETRIES, 5);
    assert.equal(cfg.POLL_INTERVAL_MS, 1500);
  });

  it("allows ephemeral PORT=0", () => {
    const cfg = loadConfig({
      PORT: "0",
      GIT_USER_EMAIL: "agent@helmcode.app",
    });
    assert.equal(cfg.PORT, 0);
  });

  it("requires GATEWAY_URL in commercial-saas mode", () => {
    assert.throws(
      () =>
        loadConfig({
          HELM_MODE: "commercial-saas",
          GIT_USER_EMAIL: "agent@helmcode.app",
        }),
      /GATEWAY_URL is required/,
    );
  });

  it("accepts commercial-saas with gateway url", () => {
    const cfg = loadConfig({
      HELM_MODE: "commercial-saas",
      GATEWAY_URL: "http://gateway.internal:9000",
      GIT_USER_EMAIL: "agent@helmcode.app",
    });
    assert.equal(cfg.mode, "commercial-saas");
    assert.equal(cfg.GATEWAY_URL, "http://gateway.internal:9000");
  });

  it("rejects invalid LOG_LEVEL", () => {
    assert.throws(
      () =>
        loadConfig({
          LOG_LEVEL: "verbose",
          GIT_USER_EMAIL: "agent@helmcode.app",
        }),
      /Invalid environment configuration/,
    );
  });
});
