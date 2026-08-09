/**
 * OpenCode tool / patch parts → Cursor-style ToolAction rows.
 *
 * Shapes (SDK types.gen.ts):
 * - ToolPart: `{ type: "tool", tool, state: { status, input, title, output } }`
 * - PatchPart: `{ type: "patch", files: string[], hash }`
 */

import {
  asRecord,
  firstString,
  looksLikePath,
  shortPath,
  toolVerb,
  truncate,
  truncateBlock,
} from "./map-util.js";

/** One tool/action row for iPad UI (path + optional body). */
export interface ToolAction {
  /** OpenCode tool name: read | edit | write | bash | … */
  name: string;
  /** One-line summary, e.g. "Read src/foo.ts". */
  label: string;
  path?: string;
  /** Edit/write body, patch text, or command output snippet. */
  content?: string;
  status?: string;
}

export function formatToolPart(
  pr: Record<string, unknown>,
): ToolAction | undefined {
  // Prefer OpenCode `tool` — never fall back to part `id` (opaque uuid).
  const rawName =
    firstString(pr, ["tool", "name", "toolName"])?.trim() || "tool";
  const tool = rawName.toLowerCase();

  const state = asRecord(pr.state);
  const input = asRecord(state.input ?? pr.input ?? pr.args ?? pr.arguments);
  const status =
    firstString(state, ["status"]) ?? firstString(pr, ["status"]) ?? "";
  const title =
    firstString(state, ["title"]) ?? firstString(pr, ["title"]) ?? "";
  const output =
    firstString(state, ["output", "result", "error"]) ??
    firstString(pr, ["output", "result"]);

  const path = extractToolPath(input, pr, title);
  const command =
    firstString(input, ["command", "cmd", "script"]) ??
    firstString(pr, ["command"]);
  const pattern = firstString(input, ["pattern", "query", "glob", "include"]);
  const content = extractToolContent(tool, input, output);

  const base = (label: string): ToolAction => ({
    name: tool,
    label,
    ...(path ? { path } : {}),
    ...(content ? { content } : {}),
    ...(status ? { status } : {}),
  });

  switch (tool) {
    case "read":
    case "view":
    case "cat":
      return base(path ? `Read ${shortPath(path)}` : "Read file");
    case "edit":
    case "write":
    case "create":
    case "apply_patch":
    case "apply-patch":
    case "str_replace":
    case "strreplace":
    case "str_replace_editor":
    case "multiedit":
    case "multi_edit":
      return base(path ? `Edit ${shortPath(path)}` : "Edit file");
    case "bash":
    case "shell":
    case "run":
    case "terminal": {
      const label = command ? `Ran ${truncate(command, 72)}` : "Ran command";
      let body: string | undefined;
      if (command && output) {
        body = truncateBlock(`$ ${command}\n${output}`, 1500);
      } else if (command) {
        body = command;
      } else if (output) {
        body = truncateBlock(output, 1500);
      }
      return {
        name: tool,
        label,
        ...(path ? { path } : {}),
        ...(body ? { content: body } : {}),
        ...(status ? { status } : {}),
      };
    }
    case "grep":
    case "search":
    case "rg":
      return base(
        pattern
          ? `Searched ${truncate(pattern, 48)}`
          : path
            ? `Searched ${shortPath(path)}`
            : "Searched",
      );
    case "glob":
    case "list":
    case "ls":
      return base(
        path || pattern
          ? `Listed ${shortPath(path ?? pattern ?? "")}`
          : "Listed files",
      );
    case "todowrite":
    case "todo":
    case "todoread":
      return base("Updated todos");
    case "webfetch":
    case "web_fetch":
    case "websearch":
    case "web_search":
      return base("Fetched web");
    default: {
      if (path) return base(`${toolVerb(tool)} ${shortPath(path)}`);
      if (command) {
        return {
          name: tool,
          label: `${toolVerb(tool)} ${truncate(command, 72)}`,
          content: content ?? command,
          ...(status ? { status } : {}),
        };
      }
      if (status === "pending" || status === "running") {
        return base(`${toolVerb(tool)}…`);
      }
      if (title && looksLikePath(title)) {
        return base(`${toolVerb(tool)} ${shortPath(title)}`);
      }
      return base(`${toolVerb(tool)} file`);
    }
  }
}

export function formatPatchParts(pr: Record<string, unknown>): ToolAction[] {
  const filesRaw = pr.files;
  const files = Array.isArray(filesRaw)
    ? filesRaw.filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];
  if (files.length === 0) return [];
  return files.map((file) => ({
    name: "patch",
    label: `Edit ${shortPath(file)}`,
    path: file,
  }));
}

function extractToolPath(
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

function extractToolContent(
  tool: string,
  input: Record<string, unknown>,
  output: string | undefined,
): string | undefined {
  const t = tool.toLowerCase();

  const full =
    firstString(input, [
      "content",
      "contents",
      "new_string",
      "newString",
      "new_str",
      "text",
      "code",
    ]) ?? undefined;

  const oldStr =
    firstString(input, ["old_string", "oldString", "old_str", "oldText"]) ??
    undefined;
  const newStr =
    firstString(input, ["new_string", "newString", "new_str", "newText"]) ??
    undefined;

  if (oldStr !== undefined && newStr !== undefined) {
    const oldLines = oldStr.split("\n").slice(0, 40).map((l) => `- ${l}`);
    const newLines = newStr.split("\n").slice(0, 40).map((l) => `+ ${l}`);
    return truncateBlock([...oldLines, ...newLines].join("\n"), 4000);
  }

  if (
    full &&
    (t === "write" ||
      t === "edit" ||
      t === "create" ||
      t === "str_replace" ||
      t === "strreplace" ||
      t === "multiedit" ||
      t === "multi_edit")
  ) {
    return truncateBlock(full, 4000);
  }

  const patch =
    firstString(input, ["patchText", "patch", "diff", "edits"]) ?? undefined;
  if (patch) return truncateBlock(patch, 4000);

  if (Array.isArray(input.edits)) {
    const chunks: string[] = [];
    for (const e of input.edits.slice(0, 12)) {
      const er = asRecord(e);
      const o = firstString(er, ["old_string", "oldString"]) ?? "";
      const n = firstString(er, ["new_string", "newString"]) ?? "";
      if (o || n) {
        chunks.push(`- ${truncate(o, 200)}\n+ ${truncate(n, 200)}`);
      }
    }
    if (chunks.length) return truncateBlock(chunks.join("\n\n"), 4000);
  }

  if ((t === "read" || t === "view" || t === "cat") && output) {
    return truncateBlock(output, 1200);
  }
  if ((t === "bash" || t === "shell" || t === "run") && output) {
    return truncateBlock(output, 1500);
  }
  return undefined;
}
