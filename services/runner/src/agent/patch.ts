import path from "node:path";
import type { Logger } from "../logger.js";
import type { FilePatch } from "../types.js";
import {
  assertSafeRelativePath,
  writeTextFile,
} from "../util/fs.js";
import { ContextBuilder } from "./contextBuilder.js";

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
  const root = path.resolve(worktreeRoot);

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

    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      log.warn("skipping path escape", { path: rel });
      skipped.push(rel);
      continue;
    }

    await writeTextFile(abs, patch.content, {
      ensureDir: patch.ensureDir !== false,
    });
    applied.push(rel);
    log.info("patched file", {
      path: rel,
      bytes: Buffer.byteLength(patch.content, "utf8"),
    });
  }

  return { applied, skipped };
}

/**
 * Load selected relative files for LLM context.
 * Thin wrapper over {@link ContextBuilder} for callers that only need the map.
 */
export async function loadContextFiles(
  worktreeRoot: string,
  relativePaths: string[],
  opts: { maxBytesPerFile?: number } = {},
): Promise<Record<string, string>> {
  const builder = new ContextBuilder({
    ...(opts.maxBytesPerFile !== undefined
      ? { maxBytesPerFile: opts.maxBytesPerFile }
      : {}),
  });
  const built = await builder.build(worktreeRoot, relativePaths);
  return built.files;
}
