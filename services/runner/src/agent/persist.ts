/**
 * Disk store for Gateway sessions (Helm timeline + checkpoints).
 *
 * ACP session ids are not durable — the harness process dies with the runner.
 * On boot we restore Helm records and rebuild ACP lazily on the next prompt
 * (same seed-context path as conversation rewind).
 *
 * Native TUI sessions (OpenCode / Claude / Pi) are a different store and are
 * not imported here.
 */

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import type {
  SessionStatus,
  SessionUsage,
  TimelineEntry,
} from "../sessions/types.js";
import type { HelmConfigOption } from "./session-config.js";
import type { SessionCheckpoint } from "./rewind.js";

/** Disk-durable slice of a Gateway session (no ACP id / abort). */
export interface PersistableSession {
  helmId: string;
  cwd: string;
  workspaceId: string;
  title?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
  checkpoints: SessionCheckpoint[];
  seedContext?: string;
  availableModeIds: string[];
  configOptions: HelmConfigOption[];
  usage?: SessionUsage;
}

export const SESSION_STORE_VERSION = 1 as const;

export interface PersistedSession {
  version: typeof SESSION_STORE_VERSION;
  helmId: string;
  cwd: string;
  workspaceId: string;
  title?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  timeline: TimelineEntry[];
  checkpoints: SessionCheckpoint[];
  seedContext?: string;
  availableModeIds: string[];
  configOptions: HelmConfigOption[];
  usage?: SessionUsage;
}

function durableStatus(status: SessionStatus): SessionStatus {
  return status === "running" ? "idle" : status;
}

export function defaultSessionsDir(workspacesPath: string): string {
  return path.join(workspacesPath, ".sessions");
}

export function toPersistedSession(
  record: PersistableSession,
): PersistedSession {
  const status = durableStatus(record.status);
  return {
    version: SESSION_STORE_VERSION,
    helmId: record.helmId,
    cwd: record.cwd,
    workspaceId: record.workspaceId,
    ...(record.title === undefined ? {} : { title: record.title }),
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    timeline: record.timeline,
    checkpoints: record.checkpoints,
    ...(record.seedContext === undefined
      ? {}
      : { seedContext: record.seedContext }),
    availableModeIds: record.availableModeIds,
    configOptions: record.configOptions,
    ...(record.usage === undefined ? {} : { usage: record.usage }),
  };
}

export function fromPersistedSession(
  raw: PersistedSession,
): PersistableSession {
  const status = durableStatus(raw.status);
  return {
    helmId: raw.helmId,
    cwd: raw.cwd,
    workspaceId: raw.workspaceId,
    ...(raw.title === undefined ? {} : { title: raw.title }),
    status,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    timeline: raw.timeline ?? [],
    checkpoints: raw.checkpoints ?? [],
    ...(raw.seedContext === undefined ? {} : { seedContext: raw.seedContext }),
    availableModeIds: raw.availableModeIds ?? [],
    configOptions: raw.configOptions ?? [],
    ...(raw.usage === undefined ? {} : { usage: raw.usage }),
  };
}

export function parsePersistedSession(input: unknown): PersistedSession | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<PersistedSession>;
  if (row.version !== SESSION_STORE_VERSION) return null;
  if (typeof row.helmId !== "string" || !row.helmId) return null;
  if (typeof row.cwd !== "string" || !row.cwd.startsWith("/")) return null;
  if (typeof row.workspaceId !== "string" || !row.workspaceId) return null;
  if (typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") {
    return null;
  }
  if (!Array.isArray(row.timeline) || !Array.isArray(row.checkpoints)) {
    return null;
  }
  return row as PersistedSession;
}

export class SessionStore {
  private readonly pending = new Map<string, PersistableSession>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    private readonly debounceMs = 250,
  ) {}

  async loadAll(): Promise<PersistableSession[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: PersistableSession[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        const persisted = parsePersistedSession(parsed);
        if (!persisted) {
          this.logger.warn("skip malformed session file", { file });
          continue;
        }
        records.push(fromPersistedSession(persisted));
      } catch (err) {
        this.logger.warn("failed to load session file", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return records;
  }

  schedule(record: PersistableSession): void {
    this.pending.set(record.helmId, record);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writing = this.writing.then(() => this.flushPending());
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async remove(helmId: string): Promise<void> {
    this.pending.delete(helmId);
    const file = this.fileFor(helmId);
    try {
      await rm(file, { force: true });
    } catch (err) {
      this.logger.debug("session file remove failed", {
        helmId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.writing;
    await this.flushPending();
  }

  private fileFor(helmId: string): string {
    return path.join(this.dir, `${helmId}.json`);
  }

  private async flushPending(): Promise<void> {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    await mkdir(this.dir, { recursive: true });
    for (const record of batch) {
      const file = this.fileFor(record.helmId);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        await writeFile(
          tmp,
          `${JSON.stringify(toPersistedSession(record), null, 2)}\n`,
          "utf8",
        );
        await rename(tmp, file);
      } catch (err) {
        this.logger.warn("failed to persist session", {
          sessionId: record.helmId,
          error: err instanceof Error ? err.message : String(err),
        });
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    }
  }
}
