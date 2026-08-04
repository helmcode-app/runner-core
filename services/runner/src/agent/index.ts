/**
 * Agent orchestration package.
 *
 * ```
 * engine.ts       HelmCodeAgentEngine (orchestrator)
 * heal-loop.ts    recursive test + self-heal
 * llm-apply.ts    LLM → patches → disk
 * contextBuilder  contextPaths-only loader
 * router.ts       JSON-RPC controller
 * ws.ts           WebSocket /v1/agent
 * pipeline.ts     HTTP / SaaS façade
 * protocol.ts     method names + RPC helpers
 * parse-run.ts    agent/run param validation
 * ```
 */

export {
  HelmCodeAgentEngine,
  agentRunParamsToTask,
  DEFAULT_MAX_CYCLES,
  SELF_HEALING_PROMPT_TEMPLATE,
  type HelmCodeAgentEngineOptions,
  type AgentMemory,
} from "./engine.js";

export {
  ContextBuilder,
  type ContextBuilderOptions,
  type BuiltContext,
} from "./contextBuilder.js";

export {
  AgentControllerRouter,
  AgentMethod,
  AgentJsonRpcCode,
  parseAgentRunParams,
  extractTaskId,
  type AgentMethodName,
  type AgentRouterOptions,
  type AgentNotifyFn,
} from "./router.js";

export {
  createAgentGateway,
  attachAgentWebSocket,
  AGENT_WS_PATH,
  type AgentGateway,
} from "./ws.js";

export { AgentPipeline, type AgentOptions } from "./pipeline.js";

export {
  GitOrchestrator,
  branchNameForTask,
  worktreeDirForTask,
  type WorktreeHandle,
} from "./git.js";

export {
  LlmClient,
  parseLlmPatchResponse,
  extractJsonObject,
  type GeneratePatchesInput,
} from "./llm.js";

export {
  applyPatches,
  loadContextFiles,
  type ApplyPatchesResult,
} from "./patch.js";

export {
  detectTestCommand,
  formatTestFailureLog,
  runTests,
  type DetectedTestCommand,
} from "./test-runner.js";

export {
  runTestAndHeal,
  type RunTestAndHealArgs,
  type HealLoopDeps,
} from "./heal-loop.js";

export {
  invokeLlmAndApplyPatches,
  type LlmApplyArgs,
} from "./llm-apply.js";

export { resolveMaxCycles, summarizePrompt, truncate } from "./params.js";
