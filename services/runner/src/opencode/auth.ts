/**
 * Materialize OpenCode provider credentials for managed `opencode serve`.
 *
 * OpenCode reads API keys from:
 *   $HOME/.local/share/opencode/auth.json
 *
 * Shape (matches `/connect` / `opencode auth login` for type=api providers):
 *   { "<providerID>": { "type": "api", "key": "..." } }
 *
 * Local and cloud use the same path: set OPENCODE_API_KEY (Secret / .env).
 * No host auth.json mount required.
 */

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

export interface OpenCodeAuthEntry {
  type: "api";
  key: string;
}

export type OpenCodeAuthFile = Record<string, OpenCodeAuthEntry>;

/** Build auth.json object for a single API-key provider. */
export function buildOpenCodeAuthFile(
  providerId: string,
  apiKey: string,
): OpenCodeAuthFile {
  const id = providerId.trim();
  const key = apiKey.trim();
  if (!id) throw new Error("OPENCODE_AUTH_PROVIDER is empty");
  if (!key) throw new Error("OPENCODE_API_KEY is empty");
  return {
    [id]: { type: "api", key },
  };
}

export function serializeOpenCodeAuthFile(file: OpenCodeAuthFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Resolve OpenCode "home" for auth/config (not the npm install prefix). */
export function resolveOpenCodeHome(config: AppConfig): string {
  const explicit = config.OPENCODE_HOME?.trim();
  if (explicit) return explicit;
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (envHome) return envHome;
  return os.homedir();
}

/** `$HOME/.local/share/opencode/auth.json` */
export function resolveOpenCodeAuthPath(home: string): string {
  return path.join(home, ".local", "share", "opencode", "auth.json");
}

/**
 * Write auth.json from OPENCODE_API_KEY before starting managed serve.
 * Throws if managed mode has no key (local and prod both require it).
 */
export async function materializeOpenCodeAuth(
  config: AppConfig,
  logger?: Logger,
): Promise<{ authPath: string; providerId: string }> {
  const apiKey = config.OPENCODE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENCODE_API_KEY is required when OPENCODE_MANAGED=true " +
        "(OpenCode Go / provider API key from the dashboard — not a host mount)",
    );
  }

  const providerId = config.OPENCODE_AUTH_PROVIDER.trim() || "opencode";
  const home = resolveOpenCodeHome(config);
  const authPath = resolveOpenCodeAuthPath(home);
  const body = serializeOpenCodeAuthFile(
    buildOpenCodeAuthFile(providerId, apiKey),
  );

  await mkdir(path.dirname(authPath), { recursive: true });
  await writeFile(authPath, body, { encoding: "utf8", mode: 0o600 });

  logger?.info("opencode auth materialized", {
    authPath,
    providerId,
    // never log the key
  });

  return { authPath, providerId };
}
