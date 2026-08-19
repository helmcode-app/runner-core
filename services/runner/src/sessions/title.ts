/**
 * Session display titles. Cursor / Claude / ChatGPT use the first user
 * prompt — not the latest — so the list stays stable after later turns.
 */

export const PLACEHOLDER_TITLE = "New chat";

const PLACEHOLDER_TITLES = new Set([
  "",
  PLACEHOLDER_TITLE.toLowerCase(),
  "untitled chat",
  "untitled",
  "helmcode",
  "chat",
  "agent",
]);

const DEFAULT_MAX_CHARS = 72;

export type TimelineText = {
  role?: string;
  text?: string;
};

export function isPlaceholderTitle(title: string | undefined | null): boolean {
  const trimmed = title?.replace(/\s+/g, " ").trim() ?? "";
  return PLACEHOLDER_TITLES.has(trimmed.toLowerCase());
}

/** Collapse whitespace, first line, trim to `max` characters. */
export function titleFromUserPrompt(
  prompt: string,
  max = DEFAULT_MAX_CHARS,
): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return PLACEHOLDER_TITLE;
  if (line.length <= max) return line;
  const sliced = line.slice(0, max);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > max * 0.55 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:!?]+$/u, "")}…`;
}

/** First user timeline text, or undefined when none. */
export function firstUserPromptText(
  entries: TimelineText[],
): string | undefined {
  for (const entry of entries) {
    if ((entry.role ?? "").toLowerCase() !== "user") continue;
    const text = entry.text?.replace(/\s+/g, " ").trim() ?? "";
    if (text) return text;
  }
  return undefined;
}

/**
 * Keep an explicit custom title. Fill placeholders from the first user message.
 */
export function maybeTitleFromTimeline(
  current: string | undefined,
  entries: TimelineText[],
): string | undefined {
  if (!isPlaceholderTitle(current)) return current;
  const first = firstUserPromptText(entries);
  return first ? titleFromUserPrompt(first) : current;
}
