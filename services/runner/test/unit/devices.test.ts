import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SetupController } from "../../src/setup/controller.js";
import { matchTokenSync } from "../../src/setup/devices.js";
import { createWorkspaceRegistry } from "../../src/workspaces/index.js";
import {
  createLocalGitFixture,
  makeTempDir,
  removeTempDir,
  testConfig,
  testLogger,
} from "../helpers.js";

async function createSetup(cfg: ReturnType<typeof testConfig>) {
  return SetupController.create(cfg, testLogger(), {
    quiet: true,
    workspaces: await createWorkspaceRegistry(cfg),
  });
}

describe("device enrollment", () => {
  it("invites a second device only after the first one approves", async () => {
    const root = await makeTempDir("helm-devices-");
    try {
      const fx = await createLocalGitFixture(root);
      const cfg = testConfig({
        MAIN_REPO_PATH: fx.mainRepoPath,
        WORKSPACES_PATH: fx.workspacesPath,
      });
      const setup = await createSetup(cfg);
      const code = await setup.printEnrollCode();
      const first = await setup.enrollDevice(
        { socket: {} } as never,
        code,
        "First iPad",
      );
      assert.equal(first.status, "complete");
      if (first.status !== "complete") return;

      const invite = await setup.inviteDevice("http://192.168.1.8:18080");
      assert.match(invite.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      assert.ok(invite.qrPayload.includes("192.168.1.8"));
      assert.ok(!invite.qrPayload.includes(first.token));

      const pending = await setup.enrollDevice(
        { socket: {} } as never,
        invite.code,
        "Second iPad",
      );
      assert.equal(pending.status, "pending");
      if (pending.status !== "pending") return;
      assert.equal((await setup.pendingEnrollments()).length, 1);

      await setup.approve(pending.enrollmentId);
      const polled = await setup.poll(pending.enrollmentId);
      assert.equal(polled.status, "complete");
      if (polled.status !== "complete") return;
      assert.notEqual(polled.token, first.token);
      assert.equal(polled.runnerId, first.runnerId);
      await assert.rejects(() => setup.poll(pending.enrollmentId));

      const recovered = await setup.printRecoverCode();
      assert.equal(
        matchTokenSync(`${fx.workspacesPath}/.setup`, first.token),
        null,
      );
      assert.equal(
        matchTokenSync(`${fx.workspacesPath}/.setup`, polled.token),
        null,
      );
      const again = await setup.enrollDevice(
        { socket: {} } as never,
        recovered,
        "Recovered iPad",
      );
      assert.equal(again.status, "complete");
    } finally {
      await removeTempDir(root);
    }
  });

  it("refuses to revoke the last device and issues a single-use ws ticket", async () => {
    const root = await makeTempDir("helm-devices-revoke-");
    try {
      const fx = await createLocalGitFixture(root);
      const setup = await createSetup(
        testConfig({
          MAIN_REPO_PATH: fx.mainRepoPath,
          WORKSPACES_PATH: fx.workspacesPath,
        }),
      );
      const code = await setup.printEnrollCode();
      const enrolled = await setup.enrollDevice(
        { socket: {} } as never,
        code,
        "Only iPad",
      );
      assert.equal(enrolled.status, "complete");
      if (enrolled.status !== "complete") return;
      const listed = await setup.devices({
        headers: { authorization: `Bearer ${enrolled.token}` },
      } as never);
      assert.equal(listed.devices.length, 1);
      const only = listed.devices[0];
      assert.ok(only);
      await assert.rejects(() => setup.revoke(only.id), /setup:recover/);

      const ticket = setup.issueWsTicket();
      const url = new URL(`http://runner/v1/terminal?ticket=${ticket.ticket}`);
      assert.equal(
        setup.authorizeUpgrade({ headers: {} } as never, url),
        true,
      );
      assert.equal(
        setup.authorizeUpgrade({ headers: {} } as never, url),
        false,
      );
      const leaked = new URL(
        `http://runner/v1/terminal?token=${enrolled.token}`,
      );
      assert.equal(
        setup.authorizeUpgrade({ headers: {} } as never, leaked),
        false,
      );
    } finally {
      await removeTempDir(root);
    }
  });
});
