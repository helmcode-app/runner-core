/**
 * Agent orchestration: git worktrees, LLM patches, self-healing tests, push.
 */
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
export { applyLlmTurn, type LlmTurnParams } from "./turn.js";
export { runSelfHealingTests, type HealLoopParams } from "./heal.js";
