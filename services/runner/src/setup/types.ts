export type SetupPhase = "pairing" | "github" | "clone" | "ready";

export interface SetupState {
  version: 1;
  phase: SetupPhase;
  /**
   * Legacy shared Bearer. Ignored for auth and stripped on boot.
   * Device tokens live in devices.json.
   */
  apiToken?: string;
  /** Legacy log claim. Ignored and stripped on boot. */
  claim?: string;
  /** At least one device has enrolled. */
  paired?: boolean;
  createdAt: string;
  updatedAt: string;
  github?: {
    login: string;
    accessToken: string;
  };
  repo?: {
    owner: string;
    repo: string;
    defaultBranch?: string;
  };
}

/** Unauthenticated. No repo names, logins, or codes. */
export interface SetupPublicStatus {
  paired: boolean;
  authRequired: true;
}

export interface SetupWorkspaceRef {
  id: string;
  path: string;
  kind: string;
  repo?: { owner: string; repo: string };
}

/** Operator cookie or device Bearer. Used by the setup page after unlock. */
export interface SetupOperatorStatus {
  phase: SetupPhase;
  githubConfigured: boolean;
  githubLogin?: string;
  repo?: { owner: string; repo: string };
  /** True when at least one repository is available on this runner. */
  hasRepo: boolean;
  paired: boolean;
  /** All registered workspaces (primary + cloned projects). */
  workspaces: SetupWorkspaceRef[];
  /** Set on clone responses: which workspace was just created/filled. */
  workspaceId?: string;
}

export interface PairingTicket {
  code: string;
  expiresAt: number;
  qrPayload: string;
  /** PNG data URL generated on the server (no CDN). */
  qrDataUrl: string;
}
