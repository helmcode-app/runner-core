import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { installCurlScript, isExecutable } from "../../src/agent/harnesses/install.js";
import { makeTempDir, removeTempDir } from "../helpers.js";

describe("harness curl install", () => {
  let home = "";

  before(async () => {
    home = await makeTempDir("helm-curl-install-");
  });

  after(async () => {
    if (home) await removeTempDir(home);
  });

  it("downloads and runs an installer into HOME/.local/bin", async () => {
    const upstream = path.join(home, "upstream-install.sh");
    await writeFile(
      upstream,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'mkdir -p "$HOME/.local/bin"',
        'cat > "$HOME/.local/bin/agent" <<\'EOF\'',
        "#!/usr/bin/env bash",
        "echo 9.9.9-test",
        "EOF",
        'chmod +x "$HOME/.local/bin/agent"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await chmod(upstream, 0o755);

    const result = await installCurlScript({
      url: `file://${upstream}`,
      home,
      timeoutMs: 30_000,
    });
    assert.ok(result.durationMs >= 0);

    const agent = path.join(home, ".local", "bin", "agent");
    assert.equal(await isExecutable(agent), true);
    const body = await readFile(agent, "utf8");
    assert.match(body, /9\.9\.9-test/);
  });

  it("rejects a missing installer URL", async () => {
    const emptyHome = path.join(home, "missing-home");
    await mkdir(emptyHome, { recursive: true });
    await assert.rejects(
      () =>
        installCurlScript({
          url: `file://${path.join(emptyHome, "nope.sh")}`,
          home: emptyHome,
          timeoutMs: 10_000,
        }),
      /Failed to download installer/i,
    );
  });
});
