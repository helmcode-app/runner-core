/**
 * Agent system prompts and cycle defaults.
 */

/** Default self-heal cycles when not specified on the request or config. */
export const DEFAULT_MAX_CYCLES = 3;

/**
 * High-intensity self-healing prompt fragment.
 * Appended with the failure log when a test cycle fails.
 */
export const SELF_HEALING_PROMPT_TEMPLATE = `You are HelmCode Self-Healing Agent. The previous code edit FAILED compilation or tests.

Your mission:
1. Analyze the syntax / import / type / logic error in the failure log below with extreme precision.
2. Identify the root cause (missing import, wrong signature, broken assert, etc.).
3. Emit a FULL file rewrite for every file that must change — not a partial diff.
4. Prefer minimal, correct, compilable fixes. Do not invent unrelated refactors.
5. Respond with a single JSON object only (no markdown fences):
{
  "summary": "one-line description of the heal",
  "patches": [{ "path": "relative/path.ext", "content": "complete post-fix file body" }],
  "giveUp": false,
  "reason": "optional if giveUp"
}

Failure log:
`;
