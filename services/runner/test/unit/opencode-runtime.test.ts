import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHarnessRuntime,
  defaultOpenCodePrefix,
  harnessSpec,
  npmPackageSpec,
  resolveHarnessBinPath,
  resolveStdioHarnessSettings,
} from "../../src/agent/index.js";
import { loadConfig } from "../../src/config.js";
import { testLogger } from "../helpers.js";

describe("OpenCode ACP harness settings", () => {
  it("resolves binary under overlay prefix", () => {
    const settings = resolveStdioHarnessSettings(harnessSpec("opencode"), {
      prefix: "/data/opencode",
    });
    assert.equal(
      resolveHarnessBinPath(settings),
      "/data/opencode/bin/opencode",
    );
  });

  it("bin overlay overrides prefix path", () => {
    const settings = resolveStdioHarnessSettings(harnessSpec("opencode"), {
      prefix: "/data/opencode",
      bin: "/usr/local/bin/opencode",
    });
    assert.equal(resolveHarnessBinPath(settings), "/usr/local/bin/opencode");
  });

  it("uses catalog defaults (not env) for install knobs", () => {
    const settings = resolveStdioHarnessSettings(harnessSpec("opencode"));
    assert.equal(settings.version, "latest");
    assert.equal(settings.updateIntervalHours, 24);
    assert.equal(settings.installTimeoutMs, 600_000);
    assert.equal(settings.packageName, "opencode-ai");
    assert.deepEqual(settings.args, ["acp"]);
    assert.equal(settings.prefix, defaultOpenCodePrefix());
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

  it("createHarnessRuntime selects OpenCode through the stdio supervisor", () => {
    const cfg = loadConfig({
      SESSIONS_ENABLED: "true",
      AGENT_HARNESS: "opencode",
    });
    const runtime = createHarnessRuntime(cfg, testLogger());
    assert.ok(runtime);
    assert.equal(runtime.status.harness, "opencode");
    assert.equal(runtime.status.transport, "stdio");
    assert.equal(runtime.modes.agent, "build");
  });

  it("builds npm package spec", () => {
    assert.equal(npmPackageSpec("opencode-ai", "latest"), "opencode-ai@latest");
    assert.equal(npmPackageSpec("opencode-ai", "1.2.3"), "opencode-ai@1.2.3");
  });
});
