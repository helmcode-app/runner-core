import assert from "node:assert/strict";
import { accessSync, constants, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { VfsBridge, resolveHelmVfsBinary } from "../../src/vfs/index.js";
import {
  makeTempDir,
  removeTempDir,
  testLogger,
} from "../helpers.js";

function hasBinary(): boolean {
  try {
    const p = resolveHelmVfsBinary();
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

describe("VfsBridge + helm-vfs", { skip: !hasBinary() }, () => {
  let root = "";
  let bridge: VfsBridge;

  before(async () => {
    root = await makeTempDir("helm-vfs-bridge-");
    mkdirSync(path.join(root, "pkg"), { recursive: true });
    writeFileSync(path.join(root, "pkg", "a.go"), "package pkg\n", "utf8");

    bridge = new VfsBridge({
      root,
      binaryPath: resolveHelmVfsBinary(),
      logger: testLogger(),
    });
    await bridge.start();
  });

  after(async () => {
    await bridge.stop();
    if (root) await removeTempDir(root);
  });

  it("initialize returns tree entries", async () => {
    const init = await bridge.initialize(root);
    assert.ok(init.entries.some((e) => e.path === "pkg/a.go"));
  });

  it("read / write files", async () => {
    const r1 = await bridge.read("pkg/a.go");
    assert.match(r1.content, /package pkg/);

    await bridge.write("pkg/b.go", "package pkg\n// b\n");
    const r2 = await bridge.read("pkg/b.go");
    assert.match(r2.content, /\/\/ b/);
  });

  it("emits didChange on external write", async () => {
    const seen = new Promise<{ path: string; type: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("didChange timeout")), 3000);
      bridge.once("didChange", (p) => {
        clearTimeout(t);
        resolve(p as { path: string; type: string });
      });
    });
    writeFileSync(path.join(root, "pkg", "c.go"), "package pkg\n", "utf8");
    const ev = await seen;
    assert.equal(ev.path, "pkg/c.go");
    assert.ok(["create", "write"].includes(ev.type));
  });
});
