/**
 * Owns agent lifecycle for open-core: load/save config, spawn ACP, switch harness.
 *
 * Runner boots without ACP. Client configures via `/v1/agent`; this controller
 * persists selection and starts/stops/replaces the harness process.
 */

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { WorkspaceRegistry } from "../workspaces/index.js";
import {
  agentConfigFromEnv,
  defaultAgentConfigPath,
  effectiveAppConfig,
  loadPersistedAgentConfig,
  mergeAgentConfigUpdate,
  redactApiKey,
  savePersistedAgentConfig,
  validateAgentConfig,
  type AgentConfigSource,
  type AgentConfigUpdate,
  type PersistedAgentConfig,
} from "./config-store.js";
import { AgentGateway } from "./gateway.js";
import {
  AGENT_HARNESS_IDS,
  HARNESS_SPECS,
  type AgentHarnessId,
} from "./harnesses/catalog.js";
import { createHarnessRuntime } from "./harnesses/create.js";
import type { HarnessOverlay } from "./harnesses/stdio-settings.js";
import type { HarnessRuntime, HarnessStatus } from "./harnesses/types.js";
import {
  isAgentProviderId,
  type AgentProviderId,
} from "./harnesses/opencode/auth.js";

export type { AgentConfigSource, AgentConfigUpdate, PersistedAgentConfig };

export type AgentRuntimePhase =
  | "disabled"
  | "starting"
  | "ready"
  | "error"
  | "stopped";

export interface HarnessCatalogEntry {
  id: AgentHarnessId;
  providers: "required" | "unused";
  impliedProvider: string;
  apiKeyEnv?: string;
}

export interface AgentConfigView {
  enabled: boolean;
  harness?: AgentHarnessId;
  provider?: AgentProviderId;
  defaultModel?: string;
  hasApiKey: boolean;
  apiKeyHint?: string;
  source: AgentConfigSource;
  phase: AgentRuntimePhase;
  error?: string;
  harnesses: HarnessCatalogEntry[];
  managed?: HarnessStatus | false;
}

export interface AgentRuntimeController {
  /** Effective selection used for spawn (file or env bootstrap). */
  readonly selection: PersistedAgentConfig | null;
  readonly source: AgentConfigSource;
  readonly enabled: boolean;
  readonly gateway: AgentGateway | null;
  readonly harness: HarnessRuntime | null;
  readonly effectiveConfig: AppConfig;
  view(): AgentConfigView;
  boot(): Promise<void>;
  apply(update: AgentConfigUpdate): Promise<AgentConfigView>;
  disable(): Promise<AgentConfigView>;
  stop(): Promise<void>;
}

export interface CreateAgentRuntimeControllerOptions {
  workspaces?: WorkspaceRegistry;
  harnessOverlay?: HarnessOverlay;
  /** Override agent.json path (tests). */
  configPath?: string;
}

class AgentRuntimeControllerImpl implements AgentRuntimeController {
  private selectionState: PersistedAgentConfig | null = null;
  private sourceState: AgentConfigSource = "none";
  private runtime: {
    gateway: AgentGateway;
    harness: HarnessRuntime;
    config: AppConfig;
  } | null = null;
  private phase: AgentRuntimePhase = "disabled";
  private lastError: string | undefined;
  private op: Promise<void> = Promise.resolve();
  private readonly configPath: string;

  constructor(
    private readonly baseConfig: AppConfig,
    private readonly logger: Logger,
    private readonly opts: CreateAgentRuntimeControllerOptions = {},
  ) {
    this.configPath =
      opts.configPath ?? defaultAgentConfigPath(baseConfig.WORKSPACES_PATH);
  }

  get selection(): PersistedAgentConfig | null {
    return this.selectionState;
  }

  get source(): AgentConfigSource {
    return this.sourceState;
  }

  get enabled(): boolean {
    return Boolean(this.selectionState?.enabled && this.runtime);
  }

  get gateway(): AgentGateway | null {
    return this.runtime?.gateway ?? null;
  }

  get harness(): HarnessRuntime | null {
    return this.runtime?.harness ?? null;
  }

  get effectiveConfig(): AppConfig {
    return effectiveAppConfig(this.baseConfig, this.selectionState);
  }

  view(): AgentConfigView {
    const sel = this.selectionState;
    const redacted = redactApiKey(sel?.apiKey);
    const view: AgentConfigView = {
      enabled: Boolean(sel?.enabled),
      source: this.sourceState,
      phase: this.phase,
      hasApiKey: redacted.hasApiKey,
      harnesses: catalogEntries(),
    };
    if (sel?.harness) view.harness = sel.harness;
    if (sel?.provider) view.provider = sel.provider;
    if (sel?.defaultModel) view.defaultModel = sel.defaultModel;
    if (redacted.apiKeyHint) view.apiKeyHint = redacted.apiKeyHint;
    if (this.lastError) view.error = this.lastError;
    if (this.runtime) {
      view.managed = this.runtime.harness.status;
    } else if (sel?.enabled) {
      view.managed = false;
    }
    return view;
  }

  async boot(): Promise<void> {
    await this.serialize(async () => {
      const fromFile = await loadPersistedAgentConfig(this.configPath);
      if (fromFile) {
        this.selectionState = fromFile;
        this.sourceState = "file";
      } else {
        const fromEnv = agentConfigFromEnv(this.baseConfig);
        if (fromEnv) {
          this.selectionState = fromEnv;
          this.sourceState = "env";
        } else {
          this.selectionState = null;
          this.sourceState = "none";
          this.phase = "disabled";
          this.lastError = undefined;
          return;
        }
      }

      if (!this.selectionState.enabled) {
        this.phase = "disabled";
        this.lastError = undefined;
        return;
      }

      const invalid = validateAgentConfig(this.selectionState);
      if (invalid) {
        this.phase = "error";
        this.lastError = invalid;
        this.logger.warn("agent config invalid; sessions stay disabled", {
          error: invalid,
        });
        return;
      }

      try {
        // Resume only — never download harnesses on cold start.
        await this.startRuntime(this.selectionState, { install: false });
      } catch (err) {
        // Keep runner up; client can fix via PUT /v1/agent.
        this.logger.error("agent boot failed; sessions stay unavailable", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  async apply(update: AgentConfigUpdate): Promise<AgentConfigView> {
    await this.serialize(async () => {
      if (
        !(AGENT_HARNESS_IDS as readonly string[]).includes(update.harness)
      ) {
        throw new AgentConfigError(`unknown harness: ${update.harness}`);
      }
      if (update.provider !== undefined && !isAgentProviderId(update.provider)) {
        throw new AgentConfigError(`unknown provider: ${update.provider}`);
      }

      const next = mergeAgentConfigUpdate(this.selectionState, update);
      const invalid = validateAgentConfig(next);
      if (invalid) throw new AgentConfigError(invalid);

      await savePersistedAgentConfig(this.configPath, next);
      this.selectionState = next;
      this.sourceState = "file";

      await this.tearDownRuntime();

      if (!next.enabled) {
        this.phase = "disabled";
        this.lastError = undefined;
        this.logger.info("agent sessions disabled via config");
        return;
      }

      try {
        // App Update / Enable — install missing harness then start ACP.
        await this.startRuntime(next, { install: true });
      } catch {
        // Config already persisted; view() exposes phase/error.
      }
    });
    return this.view();
  }

  async disable(): Promise<AgentConfigView> {
    const harness = this.selectionState?.harness ?? this.baseConfig.AGENT_HARNESS;
    return this.apply({
      enabled: false,
      harness,
      ...(this.selectionState?.provider
        ? { provider: this.selectionState.provider }
        : {}),
    });
  }

  async stop(): Promise<void> {
    await this.serialize(async () => {
      await this.tearDownRuntime();
      if (this.selectionState?.enabled) {
        this.phase = "stopped";
      } else {
        this.phase = "disabled";
      }
    });
  }

  private async startRuntime(
    selection: PersistedAgentConfig,
    opts: { install: boolean },
  ): Promise<void> {
    this.phase = "starting";
    this.lastError = undefined;
    const effective = effectiveAppConfig(this.baseConfig, selection);
    this.logger.info("starting agent runtime", {
      harness: selection.harness,
      source: this.sourceState,
      transport: "stdio",
      install: opts.install,
    });

    try {
      const harness = createHarnessRuntime(
        effective,
        this.logger,
        this.opts.harnessOverlay,
      );
      if (!harness) {
        throw new Error(
          `Failed to create ACP harness runtime (${selection.harness})`,
        );
      }

      const gateway = new AgentGateway(
        effective,
        this.logger.child({ component: "agent-gateway" }),
        () => harness.getConnection(),
        harness,
        this.opts.workspaces,
      );
      harness.setSessionUpdateHandler((params) => {
        gateway.handleAcpUpdate(params);
      });

      await harness.start({ install: opts.install });
      await gateway.restore();

      this.runtime = { gateway, harness, config: effective };
      this.phase = "ready";
      this.logger.info("agent sessions enabled", {
        harness: selection.harness,
        provider: "acp",
      });
    } catch (err) {
      this.runtime = null;
      this.phase = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.error("agent runtime failed to start", {
        harness: selection.harness,
        error: this.lastError,
      });
      throw err;
    }
  }

  private async tearDownRuntime(): Promise<void> {
    const current = this.runtime;
    this.runtime = null;
    if (!current) return;
    try {
      await current.gateway.flush();
    } catch (err) {
      this.logger.warn("agent gateway flush failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await current.harness.stop();
    } catch (err) {
      this.logger.warn("agent harness stop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.op.then(fn, fn);
    this.op = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function catalogEntries(): HarnessCatalogEntry[] {
  return AGENT_HARNESS_IDS.map((id) => {
    const spec = HARNESS_SPECS[id];
    const entry: HarnessCatalogEntry = {
      id,
      providers: spec.providers,
      impliedProvider: spec.impliedProvider,
    };
    if (spec.apiKeyEnv) entry.apiKeyEnv = spec.apiKeyEnv;
    return entry;
  });
}

export class AgentConfigError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

export function createAgentRuntimeController(
  config: AppConfig,
  logger: Logger,
  opts?: CreateAgentRuntimeControllerOptions,
): AgentRuntimeController {
  return new AgentRuntimeControllerImpl(
    config,
    logger.child({ component: "agent-controller" }),
    opts,
  );
}
