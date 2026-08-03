/**
 * Agent orchestration: git worktrees, LLM patches, self-healing tests, push.
 *
 * Layout (see also services/runner/README.md):
 * - agentEngine.ts  HelmCodeAgentEngine (orchestrator)
 * - heal-loop.ts    recursive test + self-heal
 * - llm-apply.ts    LLM → structured patches → disk
 * - contextBuilder  surgical contextPaths-only loader
 * - agentRouter/Ws  JSON-RPC controller + WebSocket gateway
 * - pipeline        thin façade for HTTP / SaaS modes
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
  attachAgentWebSocket,
  createAgentGateway,
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
  resolveGithubToken,
  redactGitSecrets,
  isPlaceholderGithubToken,
  PLACEHOLDER_GITHUB_TOKENS,
} from "../util/github-token.js";

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

export { runTestAndHeal, type RunTestAndHealArgs, type HealLoopDeps } from "./heal-loop.js";
export { invokeLlmAndApplyPatches, type LlmApplyArgs } from "./llm-apply.js";
export { resolveMaxCycles, summarizePrompt, truncate } from "./params.js";
