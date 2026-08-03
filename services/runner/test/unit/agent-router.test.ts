import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentControllerRouter,
  AgentJsonRpcCode,
  AgentMethod,
  parseAgentRunParams,
} from "../../src/agent/agentRouter.js";
import { HelmCodeAgentEngine } from "../../src/agent/agentEngine.js";
import { testConfig, testLogger } from "../helpers.js";

describe("parseAgentRunParams", () => {
  it("extracts required agent/run fields", () => {
    const p = parseAgentRunParams({
      taskId: "t1",
      prompt: "fix login",
      baseBranch: "main",
      testCommand: "go test ./...",
      contextPaths: ["a.go"],
      githubToken: "ghp_x",
      maxCycles: 3,
    });
    assert.equal(p.taskId, "t1");
    assert.equal(p.prompt, "fix login");
    assert.equal(p.baseBranch, "main");
    assert.equal(p.testCommand, "go test ./...");
    assert.deepEqual(p.contextPaths, ["a.go"]);
    assert.equal(p.githubToken, "ghp_x");
    assert.equal(p.maxCycles, 3);
  });

  it("accepts id alias for taskId", () => {
    const p = parseAgentRunParams({ id: "alias-1", prompt: "x" });
    assert.equal(p.taskId, "alias-1");
  });

  it("rejects missing prompt", () => {
    assert.throws(() => parseAgentRunParams({ taskId: "t" }), /prompt/);
  });
});

describe("AgentControllerRouter", () => {
  it("rejects unknown methods", async () => {
    const engine = new HelmCodeAgentEngine({
      config: testConfig(),
      logger: testLogger(),
    });
    const router = new AgentControllerRouter(engine);
    const res = await router.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/nope",
    });
    assert.ok(res);
    assert.ok("error" in res!);
    assert.equal(res!.error.code, AgentJsonRpcCode.MethodNotFound);
  });

  it("returns InvalidParams for bad agent/run body", async () => {
    const engine = new HelmCodeAgentEngine({
      config: testConfig(),
      logger: testLogger(),
    });
    const router = new AgentControllerRouter(engine);
    const res = await router.handle({
      jsonrpc: "2.0",
      id: 2,
      method: AgentMethod.Run,
      params: { taskId: "x" },
    });
    assert.ok(res && "error" in res);
    assert.equal(res.error.code, AgentJsonRpcCode.InvalidParams);
  });

  it("returns NotFound for agent/status of unknown task", async () => {
    const engine = new HelmCodeAgentEngine({
      config: testConfig(),
      logger: testLogger(),
    });
    const router = new AgentControllerRouter(engine);
    const res = await router.handle({
      jsonrpc: "2.0",
      id: 3,
      method: AgentMethod.Status,
      params: { taskId: "missing" },
    });
    assert.ok(res && "error" in res);
    assert.equal(res.error.code, AgentJsonRpcCode.NotFound);
  });
});
