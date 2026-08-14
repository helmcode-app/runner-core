import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AGENT_PROVIDER_AUTH_IDS,
  buildOpenCodeAuthFile,
  materializeOpenCodeAuth,
  resolveOpenCodeAuthPath,
  resolveOpenCodeAuthProviders,
  serializeOpenCodeAuthFile,
} from "../../src/agent/index.js";
import { loadConfig } from "../../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("OpenCode auth (ACP harness)", () => {
  it("maps AGENT_PROVIDER to auth.json ids", () => {
    assert.equal(AGENT_PROVIDER_AUTH_IDS["opencode-go"], "opencode-go");
    assert.equal(AGENT_PROVIDER_AUTH_IDS["opencode-zen"], "opencode");
  });

  it("resolves provider slots from AGENT_*", () => {
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go",
      AGENT_API_KEY: "k",
    });
    assert.deepEqual(resolveOpenCodeAuthProviders(cfg), [
      { providerId: "opencode-go", key: "k" },
    ]);
  });

  it("builds and serializes auth.json", () => {
    const file = buildOpenCodeAuthFile([
      { providerId: "opencode-go", key: "secret" },
    ]);
    assert.deepEqual(file, {
      "opencode-go": { type: "api", key: "secret" },
    });
    assert.match(serializeOpenCodeAuthFile(file), /opencode-go/);
  });

  it("writes auth.json under overlay home for opencode-go", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oc-auth-"));
    tempDirs.push(home);
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-go",
      AGENT_API_KEY: "go-key",
    });
    const { authPath, providerIds } = await materializeOpenCodeAuth(cfg, undefined, {
      home,
    });
    assert.equal(authPath, resolveOpenCodeAuthPath(home));
    assert.deepEqual(providerIds, ["opencode-go"]);
    const raw = JSON.parse(await readFile(authPath, "utf8")) as Record<
      string,
      { type: string; key: string }
    >;
    assert.equal(raw["opencode-go"]?.key, "go-key");
  });

  it("maps opencode-zen to auth id opencode", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "oc-auth-"));
    tempDirs.push(home);
    const cfg = loadConfig({
      AGENT_PROVIDER: "opencode-zen",
      AGENT_API_KEY: "zen-key",
    });
    const { providerIds } = await materializeOpenCodeAuth(cfg, undefined, {
      home,
    });
    assert.deepEqual(providerIds, ["opencode"]);
    const raw = JSON.parse(
      await readFile(resolveOpenCodeAuthPath(home), "utf8"),
    ) as Record<string, { key: string }>;
    assert.equal(raw.opencode?.key, "zen-key");
  });
});
