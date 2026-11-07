import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateEnrollmentCode,
  generatePairingCode,
  normalizeEnrollmentCode,
  pairingPayload,
} from "../../src/setup/index.js";
import { currentBootstrapCode } from "../../src/setup/devices.js";
import { SetupController } from "../../src/setup/controller.js";
import { createWorkspaceRegistry } from "../../src/workspaces/index.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
} from "../helpers.js";

describe("setup pairing codes", () => {
  it("generates 6-character codes without ambiguous glyphs", () => {
    const code = generatePairingCode();
    assert.equal(code.length, 6);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
  });

  it("uses an 8-character device-login code", () => {
    const code = generateEnrollmentCode();
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(normalizeEnrollmentCode("sdcn9xzs"), "SDCN-9XZS");
    assert.equal(normalizeEnrollmentCode("SDCN-9XZS"), "SDCN-9XZS");
    assert.equal(normalizeEnrollmentCode("SDCN 9XZS"), "SDCN-9XZS");
    assert.equal(normalizeEnrollmentCode("OOOO-OOOO"), null);
  });

  it("puts the short code in the QR payload, not a bearer token", () => {
    const payload = pairingPayload("http://192.168.1.8:8080", "SDCN-9XZS");
    assert.ok(payload.startsWith("helmcode://pair?"));
    assert.ok(payload.includes("c=SDCN-9XZS") || payload.includes("c=SDCN-9XZS".replace(/-/g, "%2D")) || payload.includes("SDCN-9XZS"));
    assert.ok(!payload.includes("Bearer"));
  });

  it("renders a PNG data URL for the pairing QR", async () => {
    const { pairingQrDataUrl, pairingPayload } = await import(
      "../../src/setup/codes.js"
    );
    const url = await pairingQrDataUrl(
      pairingPayload("http://192.168.1.8:8080", "AB7K2Q"),
    );
    assert.ok(url.startsWith("data:image/png;base64,"));
  });
});

describe("SetupController", () => {
  it("requires pairing even when MAIN_REPO is already a git worktree", async () => {
    const root = await makeTempDir("helm-setup-");
    try {
      const fx = await createLocalGitFixture(root);
      const cfg = testConfig({
        MAIN_REPO_PATH: fx.mainRepoPath,
        WORKSPACES_PATH: fx.workspacesPath,
      });
      const workspaces = await createWorkspaceRegistry(cfg);
      const first = await SetupController.create(cfg, testLogger(), {
        workspaces,
      });
      const status = await first.publicStatus();
      assert.equal(status.paired, false);
      assert.equal(status.authRequired, true);
      assert.equal("phase" in status, false);
      assert.equal(first.operatorStatus().phase, "pairing");
      assert.equal(first.operatorStatus().hasRepo, true);
      const setupDir = fx.workspacesPath + "/.setup";
      const code = await currentBootstrapCode(setupDir);
      assert.ok(code);
      assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

      const second = await SetupController.create(cfg, testLogger(), {
        workspaces: await createWorkspaceRegistry(cfg),
      });
      assert.equal(await currentBootstrapCode(setupDir), code);
      assert.equal(second.operatorStatus().phase, "pairing");
      const enrolled = await second.enrollDevice(
        { socket: {} } as never,
        code,
        "Test iPad",
      );
      assert.equal(enrolled.status, "complete");
      if (enrolled.status === "complete") assert.ok(enrolled.token);
      assert.equal((await second.publicStatus()).paired, true);
    } finally {
      await removeTempDir(root);
    }
  });
});
