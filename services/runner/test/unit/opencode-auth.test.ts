import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.js";
import {
  OPENCODE_GO_PROVIDER_ID,
  OPENCODE_ZEN_PROVIDER_ID,
  buildOpenCodeAuthFile,
  enabledOpenCodeProviderIds,
  materializeOpenCodeAuth,
  resolveOpenCodeAuthPath,
  resolveOpenCodeAuthProviders,
  serializeOpenCodeAuthFile,
} from "../../src/opencode/auth.js";

describe("opencode auth materialization", () => {
  it("builds auth.json for Go and Zen slots", () => {
    const file = buildOpenCodeAuthFile([
      { providerId: OPENCODE_GO_PROVIDER_ID, key: "go-key" },
      { providerId: OPENCODE_ZEN_PROVIDER_ID, key: "zen-key" },
    ]);
    assert.deepEqual(file, {
      "opencode-go": { type: "api", key: "go-key" },
      opencode: { type: "api", key: "zen-key" },
    });
    const raw = serializeOpenCodeAuthFile(file);
    assert.match(raw, /"opencode-go"/);
    assert.match(raw, /go-key/);
  });

  it("rejects empty slots", () => {
    assert.throws(() => buildOpenCodeAuthFile([]), /OPENCODE_GO_API_KEY/);
    assert.throws(
      () =>
        buildOpenCodeAuthFile([
          { providerId: OPENCODE_GO_PROVIDER_ID, key: "  " },
        ]),
      /empty/,
    );
  });

  it("resolves providers from GO / ZEN env keys only", () => {
    const goOnly = loadConfig({ OPENCODE_GO_API_KEY: "g" });
    assert.deepEqual(enabledOpenCodeProviderIds(goOnly), [
      OPENCODE_GO_PROVIDER_ID,
    ]);

    const zenOnly = loadConfig({ OPENCODE_ZEN_API_KEY: "z" });
    assert.deepEqual(enabledOpenCodeProviderIds(zenOnly), [
      OPENCODE_ZEN_PROVIDER_ID,
    ]);

    const both = loadConfig({
      OPENCODE_GO_API_KEY: "g",
      OPENCODE_ZEN_API_KEY: "z",
    });
    assert.deepEqual(
      resolveOpenCodeAuthProviders(both).map((s) => s.providerId),
      [OPENCODE_GO_PROVIDER_ID, OPENCODE_ZEN_PROVIDER_ID],
    );

    assert.deepEqual(enabledOpenCodeProviderIds(loadConfig({})), []);
  });

  it("writes auth.json under OPENCODE_HOME for Go key", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oc-auth-"));
    try {
      const cfg = loadConfig({
        OPENCODE_GO_API_KEY: "go-secret-key",
        OPENCODE_HOME: home,
      });
      const { authPath, providerIds } = await materializeOpenCodeAuth(cfg);
      assert.deepEqual(providerIds, [OPENCODE_GO_PROVIDER_ID]);
      assert.equal(authPath, resolveOpenCodeAuthPath(home));
      const written = JSON.parse(await readFile(authPath, "utf8")) as {
        "opencode-go": { type: string; key: string };
      };
      assert.equal(written["opencode-go"].type, "api");
      assert.equal(written["opencode-go"].key, "go-secret-key");
      assert.equal(
        (written as { opencode?: unknown }).opencode,
        undefined,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("writes both providers when both keys are set", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oc-auth-both-"));
    try {
      const cfg = loadConfig({
        OPENCODE_GO_API_KEY: "go-k",
        OPENCODE_ZEN_API_KEY: "zen-k",
        OPENCODE_HOME: home,
      });
      const { providerIds } = await materializeOpenCodeAuth(cfg);
      assert.deepEqual(providerIds, [
        OPENCODE_GO_PROVIDER_ID,
        OPENCODE_ZEN_PROVIDER_ID,
      ]);
      const written = JSON.parse(
        await readFile(resolveOpenCodeAuthPath(home), "utf8"),
      ) as Record<string, { key: string }>;
      assert.equal(written["opencode-go"]?.key, "go-k");
      assert.equal(written.opencode?.key, "zen-k");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("requires at least one Go/Zen key when materializing", async () => {
    const cfg = loadConfig({});
    await assert.rejects(
      () => materializeOpenCodeAuth(cfg),
      /OPENCODE_GO_API_KEY and\/or OPENCODE_ZEN_API_KEY/,
    );
  });
});
