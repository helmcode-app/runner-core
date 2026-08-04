import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type {
  AgentResult,
  AgentTask,
  ProgressCallback,
} from "../types.js";
import {
  HelmCodeAgentEngine,
  type HelmCodeAgentEngineOptions,
} from "./engine.js";

export interface AgentOptions {
  config: AppConfig;
  logger: Logger;
  onProgress?: ProgressCallback;
}

/**
 * Compatibility façade over {@link HelmCodeAgentEngine}.
 *
 * Existing open-core HTTP routes and commercial-saas workers continue to use
 * `AgentPipeline`; new WebSocket `agent/run` clients use the engine directly.
 * Both share identical orchestration semantics.
 */
export class AgentPipeline {
  private readonly engine: HelmCodeAgentEngine;

  constructor(opts: AgentOptions) {
    const engineOpts: HelmCodeAgentEngineOptions = {
      config: opts.config,
      logger: opts.logger,
    };
    if (opts.onProgress !== undefined) {
      engineOpts.onProgress = opts.onProgress;
    }
    this.engine = new HelmCodeAgentEngine(engineOpts);
  }

  /** Underlying production engine (shared memory, cancel, run). */
  get underlying(): HelmCodeAgentEngine {
    return this.engine;
  }

  get activeTaskCount(): number {
    return this.engine.activeTaskCount;
  }

  cancel(taskId: string, reason = "cancelled by client"): boolean {
    return this.engine.cancel(taskId, reason);
  }

  async run(taskInput: AgentTask): Promise<AgentResult> {
    return this.engine.run(taskInput);
  }
}
