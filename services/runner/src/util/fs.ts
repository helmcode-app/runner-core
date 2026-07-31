import { access, constants, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeTextFile(
  filePath: string,
  content: string,
  opts: { ensureDir?: boolean } = {},
): Promise<void> {
  if (opts.ensureDir !== false) {
    await ensureDir(path.dirname(filePath));
  }
  await writeFile(filePath, content, "utf8");
}

export async function readTextFile(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

/** Collect relative file paths under root (depth-limited, skips .git/node_modules). */
export async function listFiles(
  root: string,
  opts: { maxDepth?: number; maxFiles?: number; extensions?: string[] } = {},
): Promise<string[]> {
  const maxDepth = opts.maxDepth ?? 6;
  const maxFiles = opts.maxFiles ?? 500;
  const skip = new Set([".git", "node_modules", "dist", "target", "vendor", ".next"]);
  const out: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (skip.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (ent.isFile()) {
        if (opts.extensions) {
          const ext = path.extname(ent.name);
          if (!opts.extensions.includes(ext)) continue;
        }
        out.push(path.relative(root, abs));
      }
    }
  }

  const st = await stat(root).catch(() => null);
  if (!st?.isDirectory()) return out;
  await walk(root, 0);
  return out.sort();
}

export function assertSafeRelativePath(rel: string): string {
  const normalized = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (
    path.isAbsolute(normalized) ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe relative path rejected: ${rel}`);
  }
  return normalized;
}
