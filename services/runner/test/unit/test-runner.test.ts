import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  detectTestCommand,
  formatTestFailureLog,
  runTests,
} from "../../src/agent/test-runner.js";
import { testLogger } from "../helpers.js";

describe("detectTestCommand", () => {
  it("detects go.mod", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helm-go-"));
    try {
      await writeFile(path.join(root, "go.mod"), "module example\n", "utf8");
      const d = await detectTestCommand(root);
      assert.equal(d.command, "go test ./...");
      assert.match(d.reason, /go\.mod/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects Cargo.toml over later markers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helm-rs-"));
    try {
      await writeFile(path.join(root, "Cargo.toml"), "[package]\n", "utf8");
      await writeFile(path.join(root, "package.json"), "{}\n", "utf8");
      const d = await detectTestCommand(root);
      assert.equal(d.command, "cargo test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to true when no markers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helm-empty-"));
    try {
      const d = await detectTestCommand(root);
      assert.equal(d.command, "true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runTests / formatTestFailureLog", () => {
  it("runs a successful shell command", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helm-run-"));
    try {
      const result = await runTests(root, "echo ok", testLogger());
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /ok/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formats failure logs", () => {
    const log = formatTestFailureLog({
      command: "false",
      cwd: "/tmp",
      exitCode: 1,
      stdout: "out",
      stderr: "err",
      durationMs: 12,
    });
    assert.match(log, /exitCode: 1/);
    assert.match(log, /--- stderr ---/);
    assert.match(log, /err/);
  });
});
