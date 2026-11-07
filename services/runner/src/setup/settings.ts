/**
 * Setup / GitHub OAuth knobs (not secrets).
 *
 * Device flow needs a GitHub OAuth App client id (public). Put it here or in
 * `GITHUB_CLIENT_ID`. Do not add a PAT form as the main path.
 */

export interface SetupSettings {
 githubClientId?: string;
}

export const SETUP_SETTINGS_OVERLAY: SetupSettings = {
 githubClientId: "Ov23lijJhFtLyaqf16jX",
};

export function resolveSetupSettings(
 overlay?: Partial<SetupSettings>,
): SetupSettings {
 const githubClientId =
  overlay?.githubClientId?.trim() ||
  SETUP_SETTINGS_OVERLAY.githubClientId?.trim() ||
  process.env.GITHUB_CLIENT_ID?.trim();
 return {
  ...(githubClientId ? { githubClientId } : {}),
 };
}
