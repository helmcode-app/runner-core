import path from "node:path";
import type { Logger } from "../logger.js";
import type { FilePatch } from "../types.js";
import {
  assertSafeRelativePath,
  pathExists,
  readTextFile,
  writeTextFile,
} from "../util/fs.js";

export interface ApplyPatchesResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply write/replace file patches inside an isolated worktree.
 * Rejects path traversal and writes only under worktreeRoot.
 */
export async function applyPatches(
  worktreeRoot: string,
  patches: FilePatch[],
  log: Logger,
): Promise<ApplyPatchesResult> {
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const patch of patches) {
    let rel: string;
    try {
      rel = assertSafeRelativePath(patch.path);
    } catch (err) {
      log.warn("skipping unsafe patch path", {
        path: patch.path,
        error: (err as Error).message,
      });
      skipped.push(patch.path);
      continue;
    }

    const abs = path.resolve(worktreeRoot, rel);
    if (!abs.startsWith(path.resolve(worktreeRoot) + path.sep) && abs !== path.resolve(worktreeRoot)) {
      log.warn("skipping path escape", { path: rel });
      skipped.push(rel);
      continue;
    }

    await writeTextFile(abs, patch.content, {
      ensureDir: patch.ensureDir !== false,
    });
    applied.push(rel);
    log.info("patched file", { path: rel, bytes: Buffer.byteLength(patch.content, "utf8") });
  }

  return { applied, skipped };
}

/** Load selected relative files for LLM context. Missing files are ignored. */
export async function loadContextFiles(
  worktreeRoot: string,
  relativePaths: string[],
  opts: { maxBytesPerFile?: number } = {},
): Promise<Record<string, string>> {
  const maxBytes = opts.maxBytesPerFile ?? 48_000;
  const out: Record<string, string> = {};

  for (const raw of relativePaths) {
    let rel: string;
    try {
      rel = assertSafeRelativePath(raw);
    } catch {
      continue;
    }
    const abs = path.join(worktreeRoot, rel);
    if (!(await pathExists(abs))) continue;
    const content = await readTextFile(abs);
    out[rel] =
      content.length > maxBytes
        ? content.slice(0, maxBytes) + "\n…[truncated]"
        : content;
  }

  return out;
}
