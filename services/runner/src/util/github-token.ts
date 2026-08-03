/**
 * GitHub PAT resolution for agent git fetch/push.
 *
 * Distinct from OPENCORE_API_TOKEN (HTTP/WS Bearer for the runner itself).
 */

/** Compose / smoke placeholders that must never be injected as git Authorization. */
export const PLACEHOLDER_GITHUB_TOKENS = new Set([
  "local-dev-token",
  "smoke-local-token",
  "dummy",
  "changeme",
]);

/**
 * First non-empty, non-placeholder token wins.
 * Empty / placeholders → undefined (do not set Authorization).
 */
export function resolveGithubToken(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const raw of candidates) {
    const t = raw?.trim();
    if (!t) continue;
    if (PLACEHOLDER_GITHUB_TOKENS.has(t)) continue;
    return t;
  }
  return undefined;
}

/** Redact embedded PATs / basic auth from git stderr shown to clients. */
export function redactGitSecrets(text: string): string {
  return text
    .replace(/ghp_[A-Za-z0-9_]+/g, "ghp_***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/gho_[A-Za-z0-9_]+/g, "gho_***")
    .replace(/https:\/\/[^@\s]+@github\.com/gi, "https://***@github.com");
}

export function isPlaceholderGithubToken(token: string | undefined): boolean {
  const t = token?.trim();
  return Boolean(t && PLACEHOLDER_GITHUB_TOKENS.has(t));
}
