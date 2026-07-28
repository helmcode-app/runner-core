import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSafeRelativePath } from "../../src/util/fs.js";

describe("assertSafeRelativePath", () => {
  it("accepts normal relative paths", () => {
    assert.equal(assertSafeRelativePath("src/main.go"), "src/main.go");
    assert.equal(assertSafeRelativePath("pkg/a/b.ts"), "pkg/a/b.ts");
  });

  it("normalizes ./ prefixes", () => {
    assert.equal(assertSafeRelativePath("./foo/bar.txt"), "foo/bar.txt");
  });

  it("rejects parent traversal", () => {
    assert.throws(() => assertSafeRelativePath("../etc/passwd"), /Unsafe/);
    assert.throws(() => assertSafeRelativePath("foo/../../etc"), /Unsafe/);
    assert.throws(() => assertSafeRelativePath(".."), /Unsafe/);
  });

  it("rejects absolute paths", () => {
    assert.throws(() => assertSafeRelativePath("/etc/passwd"), /Unsafe/);
  });

  it("rejects null bytes", () => {
    assert.throws(() => assertSafeRelativePath("foo\0bar"), /Unsafe/);
  });
});
