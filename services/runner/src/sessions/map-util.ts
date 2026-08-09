/**
 * Small pure helpers for OpenCode/wire → Helm DTO mappers.
 */

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Dot-path or flat key lookup for common OpenCode nesting. */
export function firstString(
  o: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let cur: unknown = o;
      for (const p of parts) {
        if (!cur || typeof cur !== "object") {
          cur = undefined;
          break;
        }
        cur = (cur as Record<string, unknown>)[p];
      }
      if (typeof cur === "string" && cur) return cur;
      if (typeof cur === "number") return String(cur);
      continue;
    }
    const v = o[key];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function truncateBlock(s: string, max: number): string {
  const t = s.replace(/\r\n/g, "\n");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function shortPath(p: string): string {
  const t = p.trim();
  if (t.length <= 64) return t;
  const parts = t.split(/[/\\]/).filter(Boolean);
  if (parts.length >= 2) {
    return `…/${parts.slice(-2).join("/")}`;
  }
  return truncate(t, 64);
}

export function looksLikePath(s: string): boolean {
  return s.includes("/") || s.includes("\\") || /\.\w{1,8}$/.test(s);
}

export function toolVerb(tool: string): string {
  if (!tool) return "Tool";
  const spaced = tool.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
