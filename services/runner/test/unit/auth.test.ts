import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { authorize } from "../../src/util/auth.js";

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
