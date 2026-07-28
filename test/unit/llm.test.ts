import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractJsonObject,
  LlmClient,
  parseLlmPatchResponse,
} from "../../src/core/llm.js";
import { testConfig, testLogger } from "../helpers.js";

describe("extractJsonObject", () => {
  it("returns raw object text", () => {
    assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  });

  it("strips markdown fences", () => {
    const raw = 'Here you go:\n```json\n{"summary":"x","patches":[]}\n```\n';
    assert.equal(
      extractJsonObject(raw),
      '{"summary":"x","patches":[]}',
    );
  });

  it("slices first object from prose", () => {
    const raw = 'prefix {"summary":"ok","patches":[]} trailing';
    assert.match(extractJsonObject(raw), /"summary":"ok"/);
  });
});

describe("parseLlmPatchResponse", () => {
  it("parses valid patch payload", () => {
    const res = parseLlmPatchResponse(
      JSON.stringify({
        summary: "add helper",
        patches: [{ path: "a.ts", content: "export {}\n" }],
      }),
    );
    assert.equal(res.summary, "add helper");
    assert.equal(res.patches.length, 1);
    assert.equal(res.patches[0]?.path, "a.ts");
    assert.equal(res.giveUp, false);
  });

  it("honors giveUp + reason", () => {
    const res = parseLlmPatchResponse(
      JSON.stringify({
        summary: "blocked",
        patches: [],
        giveUp: true,
        reason: "insufficient context",
      }),
    );
    assert.equal(res.giveUp, true);
    assert.equal(res.reason, "insufficient context");
  });

  it("ignores malformed patch entries", () => {
    const res = parseLlmPatchResponse(
      JSON.stringify({
        patches: [
          { path: "ok.ts", content: "x" },
          { path: 1, content: "bad" },
          null,
          { path: "no-content" },
        ],
      }),
    );
    assert.equal(res.patches.length, 1);
    assert.equal(res.patches[0]?.path, "ok.ts");
  });

  it("throws on non-JSON", () => {
    assert.throws(() => parseLlmPatchResponse("not json at all"), /Failed to parse/);
  });
});

describe("LlmClient.generatePatches", () => {
  it("returns empty patches when LLM_API_KEY is missing", async () => {
    const client = new LlmClient(testConfig(), testLogger());
    const res = await client.generatePatches({
      prompt: "do something",
      fileTree: ["README.md"],
      files: {},
      attempt: 1,
      maxAttempts: 3,
    });
    assert.equal(res.patches.length, 0);
    assert.match(res.summary, /No LLM credentials/i);
  });

  it("calls OpenAI-compatible chat completions when key is set", async () => {
    const original = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calledUrl = String(input);
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as {
        messages: unknown[];
        model: string;
      };
      assert.equal(body.model, "gpt-4o-mini");
      assert.ok(Array.isArray(body.messages));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "from-mock",
                  patches: [{ path: "x.txt", content: "y" }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const client = new LlmClient(
        testConfig({
          LLM_API_KEY: "sk-test",
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_MODEL: "gpt-4o-mini",
        }),
        testLogger(),
      );
      const res = await client.generatePatches({
        prompt: "edit",
        fileTree: [],
        files: {},
        attempt: 1,
        maxAttempts: 3,
      });
      assert.equal(calledUrl, "https://llm.example/v1/chat/completions");
      assert.equal(res.summary, "from-mock");
      assert.equal(res.patches[0]?.path, "x.txt");
    } finally {
      globalThis.fetch = original;
    }
  });
});
