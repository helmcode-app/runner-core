import path from "node:path";
import type { Logger } from "../logger.js";
import {
  assertSafeRelativePath,
  pathExists,
  readTextFile,
} from "../util/fs.js";

export interface ContextBuilderOptions {
  /** Max UTF-16 code units retained per file (default 48 KiB). */
  maxBytesPerFile?: number;
  /** Hard cap on total characters across all loaded files (default 400 KiB). */
  maxTotalBytes?: number;
  log?: Logger;
}

export interface BuiltContext {
  /** Relative path → raw file body (possibly truncated). */
  files: Record<string, string>;
  /** Paths successfully read. */
  loaded: string[];
  /** Paths skipped (missing, unsafe, or over budget). */
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}

/**
 * Surgical LLM context loader.
 *
 * Reads the raw contents of **only** the files declared in `contextPaths`
 * from the workspace, preventing context-window bloat and protecting token
 * bandwidth. Never walks the full repository tree for file bodies.
 */
export class ContextBuilder {
  private readonly maxBytesPerFile: number;
  private readonly maxTotalBytes: number;
  private readonly log: Logger | undefined;

  constructor(opts: ContextBuilderOptions = {}) {
    this.maxBytesPerFile = opts.maxBytesPerFile ?? 48_000;
    this.maxTotalBytes = opts.maxTotalBytes ?? 400_000;
    this.log = opts.log;
  }

  /**
   * Load declared context files from `workspacePath`.
   * Missing or unsafe paths are skipped with a reason (not thrown).
   */
  async build(
    workspacePath: string,
    contextPaths: string[] | undefined,
  ): Promise<BuiltContext> {
    const files: Record<string, string> = {};
    const loaded: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let totalBytes = 0;

    const paths = Array.isArray(contextPaths) ? contextPaths : [];
    if (paths.length === 0) {
      this.log?.info("ContextBuilder: empty contextPaths; surgical table is empty");
      return { files, loaded, skipped, totalBytes: 0 };
    }

    const root = path.resolve(workspacePath);

    for (const raw of paths) {
      if (totalBytes >= this.maxTotalBytes) {
        skipped.push({ path: raw, reason: "total context budget exhausted" });
        continue;
      }

      let rel: string;
      try {
        rel = assertSafeRelativePath(raw);
      } catch (err) {
        skipped.push({
          path: raw,
          reason: err instanceof Error ? err.message : "unsafe path",
        });
        continue;
      }

      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep) && abs !== root) {
        skipped.push({ path: rel, reason: "path escapes workspace" });
        continue;
      }

      if (!(await pathExists(abs))) {
        skipped.push({ path: rel, reason: "file not found" });
        continue;
      }

      let content: string;
      try {
        content = await readTextFile(abs);
      } catch (err) {
        skipped.push({
          path: rel,
          reason: err instanceof Error ? err.message : "read failed",
        });
        continue;
      }

      if (content.length > this.maxBytesPerFile) {
        const originalLen = content.length;
        content =
          content.slice(0, this.maxBytesPerFile) +
          `\n…[truncated ${originalLen - this.maxBytesPerFile} chars]`;
      }

      const remaining = this.maxTotalBytes - totalBytes;
      if (remaining <= 0) {
        skipped.push({ path: rel, reason: "total context budget exhausted" });
        continue;
      }
      if (content.length > remaining) {
        // Hard-cap without a long suffix so totalBytes never exceeds budget.
        content = content.slice(0, remaining);
      }

      files[rel] = content;
      loaded.push(rel);
      totalBytes += content.length;
    }

    this.log?.info("ContextBuilder: surgical context ready", {
      requested: paths.length,
      loaded: loaded.length,
      skipped: skipped.length,
      totalBytes,
    });

    return { files, loaded, skipped, totalBytes };
  }
}
