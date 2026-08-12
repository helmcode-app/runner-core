import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  openCodePackageSpec,
  resolveOpenCodeBinaryPath,
} from "../../src/opencode/runtime.js";

describe("opencode runtime helpers", () => {
  it("builds npm package specs", () => {
    assert.equal(openCodePackageSpec("latest"), "opencode-ai@latest");
    assert.equal(openCodePackageSpec("1.18.15"), "opencode-ai@1.18.15");
    assert.equal(openCodePackageSpec("  next  "), "opencode-ai@next");
  });

  it("resolves binary under OPENCODE_PREFIX", () => {
    const cfg = loadConfig({
      OPENCODE_PREFIX: "/data/opencode",
    });
    assert.equal(
      resolveOpenCodeBinaryPath(cfg),
      "/data/opencode/bin/opencode",
    );
  });

  it("OPENCODE_BIN overrides prefix path", () => {
    const cfg = loadConfig({
      OPENCODE_PREFIX: "/data/opencode",
      OPENCODE_BIN: "/usr/local/bin/opencode",
    });
    assert.equal(resolveOpenCodeBinaryPath(cfg), "/usr/local/bin/opencode");
  });

  it("loads managed defaults", () => {
    const cfg = loadConfig({
      OPENCODE_ENABLED: "true",
      OPENCODE_MANAGED: "true",
    });
    assert.equal(cfg.OPENCODE_ENABLED, true);
    assert.equal(cfg.OPENCODE_MANAGED, true);
    assert.equal(cfg.OPENCODE_VERSION, "latest");
    assert.equal(cfg.OPENCODE_PREFIX, "/app/.opencode");
    assert.equal(cfg.OPENCODE_SERVE_PORT, 4096);
    assert.equal(cfg.OPENCODE_UPDATE_INTERVAL_HOURS, 24);
    assert.equal(cfg.OPENCODE_INSTALL_TIMEOUT_MS, 600_000);
    assert.equal(cfg.OPENCODE_GO_API_KEY, undefined);
    assert.equal(cfg.OPENCODE_ZEN_API_KEY, undefined);
  });

  it("allows disabling periodic updates", () => {
    const cfg = loadConfig({
      OPENCODE_UPDATE_INTERVAL_HOURS: "0",
    });
    assert.equal(cfg.OPENCODE_UPDATE_INTERVAL_HOURS, 0);
  });
});
