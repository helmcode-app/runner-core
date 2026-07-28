import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { FilePatch, LlmPatchResponse } from "../types.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GeneratePatchesInput {
  prompt: string;
  /** Repo tree listing for orientation. */
  fileTree: string[];
  /** Selected file contents keyed by relative path. */
  files: Record<string, string>;
  /** Optional previous test failure log for healing turns. */
  testFailureLog?: string;
  attempt: number;
  maxAttempts: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: { message?: string };
}

const SYSTEM_PROMPT = `You are HelmCode, a production coding agent running inside an isolated git worktree.
You MUST respond with a single JSON object only (no markdown fences) matching:
{
  "summary": "one-line description of changes",
  "patches": [{ "path": "relative/path.ext", "content": "full file contents" }],
  "giveUp": false,
  "reason": "optional if giveUp"
}
Rules:
- paths are relative to the repository root; never use absolute paths or '..'
- content is the COMPLETE post-edit file body (write/replace)
- only include files you actually change or create
- prefer minimal, correct, compilable edits
- if a test failure log is provided, fix the root cause
- if the task is impossible given the repo, set giveUp=true with reason`;

export class LlmClient {
  constructor(
    private readonly config: AppConfig,
    private readonly log: Logger,
  ) {}

  async generatePatches(input: GeneratePatchesInput): Promise<LlmPatchResponse> {
    const user = this.buildUserPrompt(input);
    const raw = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ]);
    return parseLlmPatchResponse(raw);
  }

  private buildUserPrompt(input: GeneratePatchesInput): string {
    const sections: string[] = [
      `## Task\n${input.prompt}`,
      `## Attempt\n${input.attempt} / ${input.maxAttempts}`,
      `## Repository file tree (truncated)\n${input.fileTree.slice(0, 400).join("\n") || "(empty)"}`,
    ];

    const fileEntries = Object.entries(input.files);
    if (fileEntries.length > 0) {
      const body = fileEntries
        .map(([p, c]) => `### ${p}\n\`\`\`\n${truncate(c, 24_000)}\n\`\`\``)
        .join("\n\n");
      sections.push(`## Current file contents\n${body}`);
    }

    if (input.testFailureLog) {
      sections.push(
        `## Failing test output (fix this)\n\`\`\`\n${truncate(input.testFailureLog, 40_000)}\n\`\`\``,
      );
    }

    sections.push(
      "Respond with JSON only: { summary, patches: [{ path, content }], giveUp?, reason? }",
    );
    return sections.join("\n\n");
  }

  private async chat(messages: LlmMessage[]): Promise<string> {
    const apiKey = this.config.LLM_API_KEY;
    if (!apiKey) {
      // Deterministic offline path for sandboxes without LLM credentials.
      // Produces a no-op patch envelope so the pipeline remains exercisable.
      this.log.warn("LLM_API_KEY missing; returning empty patch set");
      return JSON.stringify({
        summary: "No LLM credentials configured; no file changes applied",
        patches: [],
        giveUp: false,
      });
    }

    const url = `${this.config.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.LLM_TIMEOUT_MS,
    );

    try {
      this.log.debug("llm request", {
        model: this.config.LLM_MODEL,
        messages: messages.length,
      });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.LLM_MODEL,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages,
        }),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${truncate(text, 2000)}`);
      }

      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(text) as ChatCompletionResponse;
      } catch {
        throw new Error(`LLM returned non-JSON body: ${truncate(text, 500)}`);
      }

      if (parsed.error?.message) {
        throw new Error(`LLM error: ${parsed.error.message}`);
      }

      const content = parsed.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response missing choices[0].message.content");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

}

/** Parse an LLM completion string into a structured patch response. */
export function parseLlmPatchResponse(raw: string): LlmPatchResponse {
  const jsonText = extractJsonObject(raw);
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Failed to parse LLM JSON: ${(err as Error).message}\n${truncate(raw, 800)}`,
    );
  }

  if (!data || typeof data !== "object") {
    throw new Error("LLM JSON root must be an object");
  }

  const obj = data as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" ? obj.summary : "agent patch";
  const giveUp = obj.giveUp === true;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  const patchesRaw = Array.isArray(obj.patches) ? obj.patches : [];

  const patches: FilePatch[] = [];
  for (const item of patchesRaw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.path !== "string" || typeof p.content !== "string") continue;
    patches.push({
      path: p.path,
      content: p.content,
      ensureDir: true,
    });
  }

  return { summary, patches, giveUp, ...(reason !== undefined ? { reason } : {}) };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}
