import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  buildOpenCodeAuthFile,
  materializeOpenCodeAuth,
  resolveOpenCodeAuthPath,
  serializeOpenCodeAuthFile,
} from "../../src/opencode/auth.js";

describe("opencode auth materialization", () => {
  it("builds auth.json for an api-key provider", () => {
    const file = buildOpenCodeAuthFile("opencode", "sk-test-123");
    assert.deepEqual(file, {
      opencode: { type: "api", key: "sk-test-123" },
    });
    const raw = serializeOpenCodeAuthFile(file);
    assert.match(raw, /"type": "api"/);
    assert.match(raw, /sk-test-123/);
  });

  it("rejects empty key or provider", () => {
    assert.throws(() => buildOpenCodeAuthFile("", "k"), /OPENCODE_AUTH_PROVIDER/);
    assert.throws(() => buildOpenCodeAuthFile("opencode", "  "), /OPENCODE_API_KEY/);
  });

  it("writes auth.json under OPENCODE_HOME", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oc-auth-"));
    try {
      const cfg = loadConfig({
        OPENCODE_API_KEY: "go-secret-key",
        OPENCODE_AUTH_PROVIDER: "opencode",
        OPENCODE_HOME: home,
      });
      const { authPath, providerId } = await materializeOpenCodeAuth(cfg);
      assert.equal(providerId, "opencode");
      assert.equal(authPath, resolveOpenCodeAuthPath(home));
      const written = JSON.parse(await readFile(authPath, "utf8")) as {
        opencode: { type: string; key: string };
      };
      assert.equal(written.opencode.type, "api");
      assert.equal(written.opencode.key, "go-secret-key");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("requires OPENCODE_API_KEY when materializing", async () => {
    const cfg = loadConfig({});
    await assert.rejects(
      () => materializeOpenCodeAuth(cfg),
      /OPENCODE_API_KEY is required/,
    );
  });
});
