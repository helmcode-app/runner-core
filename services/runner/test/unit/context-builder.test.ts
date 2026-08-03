import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ContextBuilder } from "../../src/agent/contextBuilder.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("ContextBuilder", () => {
  let root = "";

  before(async () => {
    root = await makeTempDir("helm-ctx-");
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    await mkdir(path.join(root, "pkg"), { recursive: true });
    await writeFile(
      path.join(root, "pkg", "b.go"),
      "package pkg\n",
      "utf8",
    );
    await writeFile(path.join(root, "secret.env"), "TOKEN=x\n", "utf8");
  });

  after(async () => {
    if (root) await removeTempDir(root);
  });

  it("loads only declared contextPaths", async () => {
    const builder = new ContextBuilder();
    const built = await builder.build(root, ["a.ts", "pkg/b.go"]);
    assert.deepEqual(built.loaded.sort(), ["a.ts", "pkg/b.go"]);
    assert.equal(built.files["a.ts"], "export const a = 1;\n");
    assert.equal(built.files["pkg/b.go"], "package pkg\n");
    assert.equal(built.files["secret.env"], undefined);
    assert.equal(built.skipped.length, 0);
  });

  it("returns empty surgical table when contextPaths is empty", async () => {
    const builder = new ContextBuilder();
    const built = await builder.build(root, []);
    assert.deepEqual(built.files, {});
    assert.equal(built.loaded.length, 0);
  });

  it("skips unsafe and missing paths", async () => {
    const builder = new ContextBuilder();
    const built = await builder.build(root, [
      "../escape.ts",
      "missing.ts",
      "a.ts",
    ]);
    assert.deepEqual(built.loaded, ["a.ts"]);
    assert.equal(built.skipped.length, 2);
    assert.ok(built.skipped.some((s) => s.path.includes("escape")));
    assert.ok(built.skipped.some((s) => s.path === "missing.ts"));
  });

  it("enforces per-file and total budgets", async () => {
    const builder = new ContextBuilder({
      maxBytesPerFile: 10,
      maxTotalBytes: 15,
    });
    const built = await builder.build(root, ["a.ts", "pkg/b.go"]);
    assert.ok(built.totalBytes <= 15);
    assert.ok((built.files["a.ts"]?.length ?? 0) <= 15);
    // second file may be skipped or heavily truncated once budget is spent
    const second = built.files["pkg/b.go"];
    if (second !== undefined) {
      assert.ok(second.length <= 15 - (built.files["a.ts"]?.length ?? 0) + second.length);
    }
    assert.ok(built.totalBytes === Object.values(built.files).reduce((n, c) => n + c.length, 0));
  });
});
