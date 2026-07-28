import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runCommand,
  runCommandOrThrow,
  runShell,
} from "../../src/util/process.js";

describe("runCommand", () => {
  it("captures stdout and exit code", async () => {
    const r = await runCommand("printf", ["hello"], { cwd: process.cwd() });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "hello");
  });

  it("returns non-zero without throwing", async () => {
    const r = await runShell("exit 7", { cwd: process.cwd() });
    assert.equal(r.exitCode, 7);
  });

  it("runCommandOrThrow rejects on failure", async () => {
    await assert.rejects(
      () => runCommandOrThrow("false", [], { cwd: process.cwd() }),
      /Command failed/,
    );
  });

  it("times out long-running commands", async () => {
    await assert.rejects(
      () =>
        runShell("sleep 5", {
          cwd: process.cwd(),
          timeoutMs: 100,
        }),
      /timed out/,
    );
  });
});
