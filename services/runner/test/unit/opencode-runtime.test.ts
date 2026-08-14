import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHarnessRuntime,
  openCodePackageSpec,
  resolveOpenCodeBinaryPath,
  resolveOpenCodeHarnessSettings,
} from "../../src/agent/index.js";
import { loadConfig } from "../../src/config.js";
import { testLogger } from "../helpers.js";

describe("OpenCode ACP harness settings", () => {
  it("resolves binary under overlay prefix", () => {
    const settings = resolveOpenCodeHarnessSettings({
      prefix: "/data/opencode",
    });
    assert.equal(
      resolveOpenCodeBinaryPath(settings),
      "/data/opencode/bin/opencode",
    );
  });

  it("bin overlay overrides prefix path", () => {
    const settings = resolveOpenCodeHarnessSettings({
      prefix: "/data/opencode",
      bin: "/usr/local/bin/opencode",
    });
    assert.equal(resolveOpenCodeBinaryPath(settings), "/usr/local/bin/opencode");
  });

  it("uses code defaults (not env) for install knobs", () => {
    const settings = resolveOpenCodeHarnessSettings();
    assert.equal(settings.version, "latest");
    assert.equal(settings.updateIntervalHours, 24);
    assert.equal(settings.installTimeoutMs, 600_000);
    assert.equal(settings.packageName, "opencode-ai");
    assert.ok(settings.prefix.length > 0);
  });

  it("parses session selection env only", () => {
    const cfg = loadConfig({
      SESSIONS_ENABLED: "true",
      AGENT_HARNESS: "opencode",
    });
    assert.equal(cfg.SESSIONS_ENABLED, true);
    assert.equal(cfg.AGENT_HARNESS, "opencode");
  });

  it("createHarnessRuntime is null when sessions are off", () => {
    const cfg = loadConfig({ SESSIONS_ENABLED: "false" });
    assert.equal(createHarnessRuntime(cfg, testLogger()), null);
  });

  it("createHarnessRuntime selects the OpenCode default", () => {
    const cfg = loadConfig({
      SESSIONS_ENABLED: "true",
      AGENT_HARNESS: "opencode",
    });
    const runtime = createHarnessRuntime(cfg, testLogger());
    assert.ok(runtime);
    assert.equal(runtime.status.harness, "opencode");
    assert.equal(runtime.status.transport, "stdio");
  });

  it("builds npm package spec", () => {
    assert.equal(openCodePackageSpec("latest"), "opencode-ai@latest");
    assert.equal(openCodePackageSpec("1.2.3"), "opencode-ai@1.2.3");
  });
});
