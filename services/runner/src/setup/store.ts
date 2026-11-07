import {
  chmod,
  chown,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { SetupPhase, SetupState } from "./types.js";

export function defaultSetupDir(workspacesPath: string): string {
  return path.join(workspacesPath, ".setup");
}

export function parseSetupState(input: unknown): SetupState | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<SetupState>;
  if (row.version !== 1) return null;
  if (
    row.phase !== "pairing" &&
    row.phase !== "github" &&
    row.phase !== "clone" &&
    row.phase !== "ready"
  ) {
    return null;
  }
  if (typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") {
    return null;
  }
  return row as SetupState;
}

export async function loadSetupState(dir: string): Promise<SetupState | null> {
  const file = path.join(dir, "setup.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return parseSetupState(parsed);
  } catch {
    return null;
  }
}

export async function saveSetupState(
  dir: string,
  state: SetupState,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "setup.json");
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  await rm(tmp, { force: true }).catch(() => undefined);
  await adoptWorkspaceOwner(dir, file);
}

/**
 * `docker exec` is root, but the runner process is the unprivileged `helm` user.
 * Root-owned 0600 setup files are invisible to it and look like a bad pairing code.
 */
export async function adoptWorkspaceOwner(
  dir: string,
  file?: string,
): Promise<void> {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  try {
    const parent = await stat(path.dirname(dir));
    if (parent.uid === 0) return;
    await chown(dir, parent.uid, parent.gid);
    if (file) await chown(file, parent.uid, parent.gid);
  } catch {
    /* best effort; CLI also drops privileges before writing */
  }
}

export function newSetupState(
  phase: SetupPhase,
  apiToken?: string,
): SetupState {
  const now = new Date().toISOString();
  return {
    version: 1,
    phase,
    ...(apiToken ? { apiToken } : {}),
    createdAt: now,
    updatedAt: now,
  };
}
