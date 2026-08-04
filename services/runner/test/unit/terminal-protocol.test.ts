import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { IncomingMessage } from "node:http";
import {
  encodeServerMessage,
  parseClientMessage,
} from "../../src/terminal/protocol.js";
import { authorizeTerminalUpgrade } from "../../src/terminal/gateway.js";
import {
  resolveShellCmd,
  pickAvailableShell,
} from "../../src/terminal/local-pty.js";

describe("terminal protocol", () => {
  it("parses resize messages", () => {
    const msg = parseClientMessage(
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
    );
    assert.deepEqual(msg, { type: "resize", cols: 120, rows: 40 });
  });

  it("rejects invalid resize", () => {
    assert.equal(
      parseClientMessage(JSON.stringify({ type: "resize", cols: 0, rows: 24 })),
      null,
    );
    assert.equal(parseClientMessage("not-json"), null);
  });

  it("parses ping and stdin", () => {
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: "ping", t: 1 })), {
      type: "ping",
      t: 1,
    });
    assert.deepEqual(
      parseClientMessage(JSON.stringify({ type: "stdin", data: "ls\n" })),
      { type: "stdin", data: "ls\n" },
    );
  });

  it("encodes server ready for local-pty", () => {
    const s = encodeServerMessage({
      type: "ready",
      sessionId: "s1",
      backend: "local-pty",
      shell: "/bin/bash -l",
      cwd: "/app/main_repo",
    });
    assert.match(s, /"ready"/);
    assert.match(s, /"local-pty"/);
    assert.match(s, /sessionId/);
  });
});

describe("authorizeTerminalUpgrade", () => {
  it("allows when token unset", () => {
    const req = { headers: {} } as IncomingMessage;
    const url = new URL("http://localhost/v1/terminal");
    assert.equal(authorizeTerminalUpgrade(req, url, undefined), true);
  });

  it("accepts Bearer header", () => {
    const req = {
      headers: { authorization: "Bearer secret" },
    } as IncomingMessage;
    const url = new URL("http://localhost/v1/terminal");
    assert.equal(authorizeTerminalUpgrade(req, url, "secret"), true);
    assert.equal(authorizeTerminalUpgrade(req, url, "other"), false);
  });

  it("accepts query token fallback", () => {
    const req = { headers: {} } as IncomingMessage;
    const url = new URL("http://localhost/v1/terminal?token=secret");
    assert.equal(authorizeTerminalUpgrade(req, url, "secret"), true);
  });
});

describe("local-pty shell resolution", () => {
  it("adds login flag for bash", () => {
    assert.deepEqual(resolveShellCmd("/bin/bash"), {
      file: "/bin/bash",
      args: ["-l"],
    });
  });

  it("splits simple multi-arg shell strings", () => {
    assert.deepEqual(resolveShellCmd("bash -l"), {
      file: "bash",
      args: ["-l"],
    });
  });

  it("picks an available shell on this host", () => {
    const picked = pickAvailableShell("/bin/bash");
    assert.ok(picked.file.length > 0);
    assert.ok(picked.display.length > 0);
  });
});
