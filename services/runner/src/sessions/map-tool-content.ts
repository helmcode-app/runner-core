/**
 * Extract path / content body from OpenCode tool parts for Cursor-style UI.
 */

import {
  asRecord,
  firstString,
  looksLikePath,
  truncateBlock,
} from "./map-util.js";

export function extractToolPath(
  input: Record<string, unknown>,
  pr: Record<string, unknown>,
  title: string,
): string | undefined {
  const direct =
    firstString(input, [
      "filePath",
      "file_path",
      "path",
      "file",
      "filename",
      "target",
      "target_file",
      "targetFile",
      "uri",
    ]) ?? firstString(pr, ["path", "file", "filename"]);
  if (direct) return direct;

  const nestedFile = asRecord(input.file);
  const fromNested =
    firstString(nestedFile, ["path", "filePath", "filename"]) ??
    firstString(asRecord(input.metadata), ["path", "filePath", "filepath"]);
  if (fromNested) return fromNested;

  const patchText = firstString(input, ["patchText", "patch", "diff"]) ?? "";
  const marker = patchText.match(
    /\*\*\*\s*(?:Add File|Update File|Delete File|Move to):\s*(.+)/,
  );
  if (marker?.[1]) return marker[1].trim();

  if (title && looksLikePath(title) && title.length < 200) return title;
  return undefined;
}

/**
 * Body for expand/collapse.
 *
 * OpenCode edit (packages/opencode/src/tool/edit.ts) after completion:
 *   state = {
 *     status: "completed",
 *     input: { filePath, oldString, newString },
 *     output: "Edit applied successfully.",   // NOT the diff
 *     title: "relative/path",
 *     metadata: { diff, filediff: { patch, additions, deletions } },
 *   }
 * Write tool puts full file in input.content; metadata has no diff.
 */
export function extractToolContent(
  tool: string,
  input: Record<string, unknown>,
  output: string | undefined,
  state: Record<string, unknown> = {},
  part: Record<string, unknown> = {},
): string | undefined {
  const t = tool.toLowerCase();
  const isEditLike =
    t === "edit" ||
    t === "write" ||
    t === "create" ||
    t === "apply_patch" ||
    t === "apply-patch" ||
    t === "str_replace" ||
    t === "strreplace" ||
    t === "str_replace_editor" ||
    t === "multiedit" ||
    t === "multi_edit" ||
    t === "patch";

  if (isEditLike) {
    // Merge every place OpenCode has been seen to stash diffs.
    const meta = {
      ...asRecord(part.metadata),
      ...asRecord(state.metadata),
      ...asRecord(input.metadata),
    };
    const filediff = asRecord(meta.filediff ?? state.filediff ?? input.filediff);

    // 1) Unified diff from metadata (primary source after edit completes).
    const fromMeta =
      findLongString(meta, ["diff", "patch"]) ??
      findLongString(filediff, ["patch", "diff", "content"]) ??
      findLongString(state, ["diff", "patch"]) ??
      findLongString(part, ["diff", "patch"]);
    if (fromMeta) return truncateBlock(fromMeta, 12_000);

    // 2) Input-side old/new (present while running; may be stripped after compaction).
    // Allow empty oldString (create-via-edit uses "").
    const oldStr = stringFieldAllowEmpty(input, [
      "old_string",
      "oldString",
      "old_str",
      "oldText",
      "old",
    ]);
    const newStr = stringFieldAllowEmpty(input, [
      "new_string",
      "newString",
      "new_str",
      "newText",
      "new",
    ]);
    if (oldStr !== undefined && newStr !== undefined) {
      return truncateBlock(toMinusPlusDiff(oldStr, newStr), 12_000);
    }
    // Only newString (rare)
    if (newStr !== undefined && newStr.length > 0 && oldStr === undefined) {
      return truncateBlock(toMinusPlusDiff("", newStr), 12_000);
    }

    // 3) Full-file write body
    const full = firstString(input, [
      "content",
      "contents",
      "text",
      "code",
      "body",
    ]);
    if (full) return truncateBlock(full, 12_000);

    // 4) apply_patch / multi-edit payloads
    const patch = firstString(input, ["patchText", "patch", "diff"]);
    if (patch) return truncateBlock(patch, 12_000);

    if (Array.isArray(input.edits)) {
      const chunks: string[] = [];
      for (const e of input.edits.slice(0, 20)) {
        const er = asRecord(e);
        const o =
          stringFieldAllowEmpty(er, ["old_string", "oldString", "old"]) ?? "";
        const n =
          stringFieldAllowEmpty(er, ["new_string", "newString", "new"]) ?? "";
        if (o || n) chunks.push(toMinusPlusDiff(o, n));
      }
      if (chunks.length) return truncateBlock(chunks.join("\n\n"), 12_000);
    }

    // 5) Stats-only fallback when additions/deletions known but body missing
    const add = numberField(filediff, ["additions", "added", "insertions"]);
    const del = numberField(filediff, ["deletions", "removed", "deletes"]);
    if (add !== undefined || del !== undefined) {
      return `+${add ?? 0} / -${del ?? 0}\n(diff body not retained by runtime)`;
    }

    // 6) Skip boilerplate success strings; keep any other output
    if (output && !isBoilerplateToolOutput(output)) {
      return truncateBlock(output, 4000);
    }
    return undefined;
  }

  if ((t === "read" || t === "view" || t === "cat") && output) {
    return truncateBlock(output, 1200);
  }
  if ((t === "bash" || t === "shell" || t === "run" || t === "terminal") && output) {
    return truncateBlock(output, 1500);
  }
  return undefined;
}

function toMinusPlusDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n").slice(0, 120).map((l) => `- ${l}`);
  const newLines = newStr.split("\n").slice(0, 120).map((l) => `+ ${l}`);
  return [...oldLines, ...newLines].join("\n");
}

function isBoilerplateToolOutput(output: string): boolean {
  const t = output.trim().toLowerCase();
  return (
    t === "ok" ||
    t === "done" ||
    t === "success" ||
    /^edit applied successfully\.?$/.test(t) ||
    /^wrote file successfully\.?$/.test(t)
  );
}

/** Prefer longer string fields (diffs are multi-line). */
function findLongString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  let best: string | undefined;
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      if (!best || v.length > best.length) best = v;
    }
  }
  return best;
}

function numberField(
  o: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

/** Like firstString but keeps empty strings (edit create uses oldString: ""). */
function stringFieldAllowEmpty(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const v = o[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

export function diffLineStats(
  diff: string,
): { additions: number; deletions: number } | undefined {
  let additions = 0;
  let deletions = 0;
  let any = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      additions++;
      any = true;
    } else if (line.startsWith("-")) {
      deletions++;
      any = true;
    }
  }
  return any ? { additions, deletions } : undefined;
}
