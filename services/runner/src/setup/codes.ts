import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateApiToken(): string {
  return randomBytes(32).toString("base64url");
}

export function generatePairingCode(length = 6): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PAIR_ALPHABET[bytes[i]! % PAIR_ALPHABET.length];
  }
  return out;
}

/**
 * Short setup code, same shape as a device-login user code (`SDCN-9XZS`).
 * Unambiguous alphabet, hyphen only for copying.
 */
export function generateEnrollmentCode(): string {
  return `${generatePairingCode(4)}-${generatePairingCode(4)}`;
}

/** Accept `SDCN-9XZS` or `SDCN9XZS`. Returns the hyphenated form, or null. */
export function normalizeEnrollmentCode(raw: string): string | null {
  const compact = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function formatSetupCodeMessage(code: string, kind: "enroll" | "recover" = "enroll"): string {
  const lines = [
    kind === "recover" ? "All devices revoked." : "No devices enrolled.",
    `Helm setup code: ${code}`,
    "Enter this code in HelmCode \u2192 Add runner. It expires in 10 minutes.",
    "",
  ];
  return `${lines.join("\n")}`;
}

export function generateSessionSecret(): string {
  return randomBytes(24).toString("hex");
}

export function pairingPayload(baseUrl: string, code: string): string {
  const q = new URLSearchParams({ url: baseUrl, c: code });
  return `helmcode://pair?${q.toString()}`;
}

export async function pairingQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: "M",
  });
}

export function publicBaseUrl(
  reqHost: string | undefined,
  proto?: string,
): string {
  const host = (reqHost ?? "localhost").trim() || "localhost";
  const scheme = proto === "https" ? "https" : "http";
  return `${scheme}://${host}`;
}
