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
    assert.equal(cfg.OPENCODE_ENABLED, false);
    assert.equal(cfg.OPENCODE_MANAGED, false);
    assert.equal(cfg.VFS_ENABLED, true);
  });

  it("parses numeric env coercions", () => {
    const cfg = loadConfig({
      PORT: "9090",
      OPENCODE_SERVE_PORT: "4100",
      OPENCODE_UPDATE_INTERVAL_HOURS: "12",
    });
    assert.equal(cfg.PORT, 9090);
    assert.equal(cfg.OPENCODE_SERVE_PORT, 4100);
    assert.equal(cfg.OPENCODE_UPDATE_INTERVAL_HOURS, 12);
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
      OPENCODE_DEFAULT_MODEL: "",
    });
    assert.equal(cfg.OPENCORE_API_TOKEN, undefined);
    assert.equal(cfg.OPENCODE_DEFAULT_MODEL, undefined);
  });
});
