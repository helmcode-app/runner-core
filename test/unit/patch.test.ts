import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import { applyPatches, loadContextFiles } from "../../src/core/patch.js";
import { testLogger } from "../helpers.js";

describe("applyPatches", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tmp(): Promise<string> {
    const d = await mkdtemp(path.join(os.tmpdir(), "helm-patch-"));
    dirs.push(d);
    return d;
  }

  it("writes nested files under the worktree", async () => {
    const root = await tmp();
    const log = testLogger();
    const result = await applyPatches(
      root,
      [{ path: "src/app.ts", content: "export const x = 1;\n" }],
      log,
    );
    assert.deepEqual(result.applied, ["src/app.ts"]);
    assert.deepEqual(result.skipped, []);
    const body = await readFile(path.join(root, "src/app.ts"), "utf8");
    assert.equal(body, "export const x = 1;\n");
  });

  it("skips path traversal patches", async () => {
    const root = await tmp();
    const log = testLogger();
    const result = await applyPatches(
      root,
      [
        { path: "../escape.txt", content: "nope" },
        { path: "ok.txt", content: "yes" },
      ],
      log,
    );
    assert.deepEqual(result.applied, ["ok.txt"]);
    assert.deepEqual(result.skipped, ["../escape.txt"]);
  });
});

describe("loadContextFiles", () => {
  it("loads existing files and ignores missing/unsafe paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "helm-ctx-"));
    try {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(path.join(root, "pkg"), { recursive: true });
      await writeFile(path.join(root, "pkg/a.go"), "package pkg\n", "utf8");

      const files = await loadContextFiles(root, [
        "pkg/a.go",
        "missing.go",
        "../etc/passwd",
      ]);
      assert.deepEqual(Object.keys(files).sort(), ["pkg/a.go"]);
      assert.equal(files["pkg/a.go"], "package pkg\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
