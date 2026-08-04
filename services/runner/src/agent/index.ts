/**
 * Agent orchestration: git worktrees, LLM patches, self-healing tests, push.
 *
 * ```
 * agentEngine  →  heal-loop / llm-apply / contextBuilder
 * agentRouter  →  agentWs  (/v1/agent)
 * pipeline     →  HTTP + commercial-saas façade
 * ```
 */

export {
  HelmCodeAgentEngine,
  agentRunParamsToTask,
  DEFAULT_MAX_CYCLES,
  SELF_HEALING_PROMPT_TEMPLATE,
  type HelmCodeAgentEngineOptions,
  type AgentMemory,
} from "./agentEngine.js";

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
  type AgentMethodName,
  type AgentRouterOptions,
  type AgentNotifyFn,
} from "./agentRouter.js";

export {
  createAgentGateway,
  attachAgentWebSocket,
  AGENT_WS_PATH,
  type AgentGateway,
} from "./agentWs.js";

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
