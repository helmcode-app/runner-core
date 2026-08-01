/**
 * Agent orchestration: git worktrees, LLM patches, self-healing tests, push.
 */
export { AgentPipeline, type AgentOptions } from "./pipeline.js";
export { GitOrchestrator, branchNameForTask, worktreeDirForTask } from "./git.js";
export { LlmClient, parseLlmPatchResponse, extractJsonObject } from "./llm.js";
export { applyPatches, loadContextFiles } from "./patch.js";
export {
  detectTestCommand,
  formatTestFailureLog,
  runTests,
  type DetectedTestCommand,
} from "./test-runner.js";
