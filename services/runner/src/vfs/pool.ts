/**
 * One helm-vfs process per workspace so parallel roots do not share a watcher.
 */

import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  DEFAULT_WORKSPACE_ID,
  type WorkspaceRegistry,
} from "../workspaces/index.js";
import { VfsBridge } from "./bridge.js";

export class VfsBridgePool {
  private readonly bridges = new Map<string, VfsBridge>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly workspaces: WorkspaceRegistry,
  ) {}

  get(workspaceId: string = DEFAULT_WORKSPACE_ID): VfsBridge | null {
    return this.bridges.get(workspaceId) ?? null;
  }

  async ensure(workspaceId?: string | null): Promise<VfsBridge | null> {
    if (!this.config.VFS_ENABLED) return null;
    const workspace = this.workspaces.get(workspaceId);
    const existing = this.bridges.get(workspace.id);
    if (existing?.isRunning) return existing;

    const bridge = new VfsBridge({
      root: workspace.path,
      logger: this.logger,
      ...(this.config.HELM_VFS_BIN !== undefined
        ? { binaryPath: this.config.HELM_VFS_BIN }
        : {}),
    });
    await bridge.start();
    this.bridges.set(workspace.id, bridge);
    return bridge;
  }

  async close(): Promise<void> {
    const running = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.all(running.map((bridge) => bridge.stop()));
  }
}
