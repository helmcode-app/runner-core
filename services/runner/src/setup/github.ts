export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
}

export interface GithubUser {
  login: string;
  accessToken: string;
}

export interface GithubRepo {
  owner: string;
  repo: string;
  private: boolean;
  defaultBranch: string;
}

interface DevicePending {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  lastPollAt: number;
}

export class GithubDeviceFlow {
  private pending: DevicePending | null = null;

  constructor(private readonly clientId: string) {}

  async start(): Promise<DeviceStart> {
    const body = await githubForm("https://github.com/login/device/code", {
      client_id: this.clientId,
      scope: "repo",
    });
    const deviceCode = String(body.device_code ?? "");
    const userCode = String(body.user_code ?? "");
    const verificationUri = String(
      body.verification_uri ?? "https://github.com/login/device",
    );
    const intervalSec = Number(body.interval ?? 5);
    const expiresIn = Number(body.expires_in ?? 900);
    if (!deviceCode || !userCode) {
      throw new Error("GitHub device flow did not return a code");
    }
    const now = Date.now();
    this.pending = {
      deviceCode,
      intervalMs: Math.max(5, intervalSec) * 1000,
      expiresAt: now + expiresIn * 1000,
      lastPollAt: 0,
    };
    return {
      deviceCode,
      userCode,
      verificationUri,
      intervalMs: this.pending.intervalMs,
      expiresAt: this.pending.expiresAt,
    };
  }

  async poll(): Promise<
    | { status: "pending"; intervalMs: number }
    | { status: "complete"; user: GithubUser }
    | { status: "expired" | "denied"; error: string }
  > {
    const pending = this.pending;
    if (!pending)
      return { status: "expired", error: "no device flow in progress" };
    if (Date.now() > pending.expiresAt) {
      this.pending = null;
      return { status: "expired", error: "device code expired" };
    }
    const wait = pending.intervalMs - (Date.now() - pending.lastPollAt);
    if (wait > 0) {
      return { status: "pending", intervalMs: wait };
    }
    pending.lastPollAt = Date.now();
    const body = await githubForm(
      "https://github.com/login/oauth/access_token",
      {
        client_id: this.clientId,
        device_code: pending.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    );
    if (body.error === "authorization_pending" || body.error === "slow_down") {
      if (body.error === "slow_down") pending.intervalMs += 5000;
      return { status: "pending", intervalMs: pending.intervalMs };
    }
    if (body.error === "expired_token") {
      this.pending = null;
      return { status: "expired", error: "device code expired" };
    }
    if (body.error === "access_denied") {
      this.pending = null;
      return { status: "denied", error: "GitHub authorization denied" };
    }
    const accessToken = String(body.access_token ?? "");
    if (!accessToken) {
      this.pending = null;
      return {
        status: "denied",
        error: String(
          body.error_description ?? body.error ?? "authorization failed",
        ),
      };
    }
    this.pending = null;
    const login = await fetchGithubLogin(accessToken);
    return { status: "complete", user: { login, accessToken } };
  }
}

export async function listGithubRepos(
  accessToken: string,
): Promise<GithubRepo[]> {
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=50&sort=updated&affiliation=owner,collaborator,organization_member",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "helmcode-runner",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub repos failed: ${res.status}`);
  }
  const rows = (await res.json()) as Array<{
    name: string;
    private: boolean;
    default_branch?: string;
    owner?: { login?: string };
  }>;
  return rows.map((row) => ({
    owner: row.owner?.login ?? "",
    repo: row.name,
    private: Boolean(row.private),
    defaultBranch: row.default_branch ?? "main",
  }));
}

async function fetchGithubLogin(accessToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "helmcode-runner",
    },
  });
  if (!res.ok) throw new Error(`GitHub user failed: ${res.status}`);
  const body = (await res.json()) as { login?: string };
  return body.login ?? "github";
}

async function githubForm(
  url: string,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "helmcode-runner",
    },
    body: JSON.stringify(fields),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return body;
}
