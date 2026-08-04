import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import {
  authorize,
  authorizeWebSocketUpgrade,
} from "../../src/http/index.js";

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

describe("authorize", () => {
  it("allows all when token unset", () => {
    assert.equal(authorize(req(), undefined), true);
    assert.equal(authorize(req("Bearer x"), undefined), true);
  });

  it("rejects missing or wrong bearer", () => {
    assert.equal(authorize(req(), "secret"), false);
    assert.equal(authorize(req("Basic secret"), "secret"), false);
    assert.equal(authorize(req("Bearer wrong"), "secret"), false);
  });

  it("accepts matching bearer token", () => {
    assert.equal(authorize(req("Bearer secret"), "secret"), true);
  });
});

describe("authorizeWebSocketUpgrade", () => {
  it("accepts query token when header missing", () => {
    const url = new URL("http://x/v1/agent?token=secret");
    assert.equal(
      authorizeWebSocketUpgrade(req(), "secret", url, { allowQueryToken: true }),
      true,
    );
  });

  it("can disable query token", () => {
    const url = new URL("http://x/v1/agent?token=secret");
    assert.equal(
      authorizeWebSocketUpgrade(req(), "secret", url, {
        allowQueryToken: false,
      }),
      false,
    );
  });
});
