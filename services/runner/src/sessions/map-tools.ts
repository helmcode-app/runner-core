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
import {
  diffLineStats,
  extractToolContent,
  extractToolPath,
} from "./map-tool-content.js";

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
  // OpenCode fills `state.input` early (while running) and adds output on complete.
  const input = asRecord(
    state.input ?? pr.input ?? pr.args ?? pr.arguments ?? state,
  );
  let status =
    firstString(state, ["status"]) ?? firstString(pr, ["status"]) ?? "";
  // Infer running when no completion markers yet.
  if (!status) {
    const hasOutput =
      firstString(state, ["output", "result"]) !== undefined ||
      firstString(pr, ["output", "result"]) !== undefined;
    const time = asRecord(state.time);
    if (!hasOutput && time.end === undefined && time.completed === undefined) {
      // Only mark running if we have an input payload (tool was actually started).
      if (Object.keys(input).length > 0) status = "running";
    }
  }
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
  // OpenCode edit puts the unified diff in state.metadata.diff (not in output).
  const content = extractToolContent(tool, input, output, state, pr);

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
    case "write":
    case "create": {
      const lines =
        typeof content === "string" && content
          ? content.split("\n").length
          : 0;
      const detail = path
        ? lines > 0
          ? `${shortPath(path)} (${lines} lines)`
          : shortPath(path)
        : lines > 0
          ? `file (${lines} lines)`
          : "file";
      return base(`Write ${detail}`);
    }
    case "edit":
    case "apply_patch":
    case "apply-patch":
    case "str_replace":
    case "strreplace":
    case "str_replace_editor":
    case "multiedit":
    case "multi_edit": {
      // Prefer path; append +N/-M when we have a unified diff body.
      let label = path ? `Edit ${shortPath(path)}` : "Edit file";
      if (content) {
        const stats = diffLineStats(content);
        if (stats) {
          label = path
            ? `Edit ${shortPath(path)}`
            : `Edit file (+${stats.additions}/-${stats.deletions})`;
        }
      }
      return base(label);
    }
    case "bash":
    case "shell":
    case "run":
    case "terminal": {
      const label = command ? `Run ${truncate(command, 72)}` : "Run";
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
