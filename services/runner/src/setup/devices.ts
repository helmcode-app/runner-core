import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  generateEnrollmentCode,
  normalizeEnrollmentCode,
} from "./codes.js";
import { adoptWorkspaceOwner } from "./store.js";

export const ENROLL_TTL_MS = 10 * 60 * 1000;

export class DeviceStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DeviceStoreError";
  }
}

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface DeviceFile {
  version: 1;
  runnerId: string;
  devices: DeviceRecord[];
}

export interface EnrollmentRequest {
  deviceName: string;
  requestedAt: string;
}

export interface EnrollmentDelivery {
  deviceId: string;
  token: string;
  runnerId: string;
}

export interface InviteRecord {
  id: string;
  code: string;
  expiresAt: number;
  createdAt: string;
  url?: string;
  request?: EnrollmentRequest;
  delivery?: EnrollmentDelivery;
  denied?: boolean;
}

export interface BootstrapCode {
  code: string;
  kind: "bootstrap" | "recover";
  expiresAt: number;
  createdAt: string;
}

export interface BrowserGrant {
  code: string;
  expiresAt: number;
}

export interface EnrollmentFile {
  version: 1;
  bootstrap?: BootstrapCode;
  invites: InviteRecord[];
  browser?: BrowserGrant;
}

export type EnrollResult =
  | {
      status: "complete";
      deviceId: string;
      token: string;
      runnerId: string;
    }
  | {
      status: "pending";
      enrollmentId: string;
      expiresAt: number;
    };

export interface PendingEnrollment {
  id: string;
  deviceName: string;
  createdAt: string;
  expiresAt: number;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt?: string;
  current: boolean;
}

function devicesPath(dir: string): string {
  return path.join(dir, "devices.json");
}

function enrollmentsPath(dir: string): string {
  return path.join(dir, "enrollments.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function emptyDevices(): DeviceFile {
  return {
    version: 1,
    runnerId: newId("rn"),
    devices: [],
  };
}

function emptyEnrollments(): EnrollmentFile {
  return { version: 1, invites: [] };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, file);
  await rm(tmp, { force: true }).catch(() => undefined);
  await adoptWorkspaceOwner(path.dirname(file), file);
}

function parseDevices(input: unknown): DeviceFile | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<DeviceFile>;
  if (row.version !== 1 || typeof row.runnerId !== "string") return null;
  if (!Array.isArray(row.devices)) return null;
  return row as DeviceFile;
}

function parseEnrollments(input: unknown): EnrollmentFile | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<EnrollmentFile>;
  if (row.version !== 1 || !Array.isArray(row.invites)) return null;
  return {
    version: 1,
    invites: row.invites,
    ...(row.bootstrap ? { bootstrap: row.bootstrap } : {}),
    ...(row.browser ? { browser: row.browser } : {}),
  };
}

export async function loadDevices(dir: string): Promise<DeviceFile> {
  try {
    const parsed = parseDevices(
      JSON.parse(await readFile(devicesPath(dir), "utf8")),
    );
    if (parsed) return parsed;
  } catch (err) {
    if (isPermissionError(err)) throw unreadableSetup(err);
  }
  const created = emptyDevices();
  await writeJson(devicesPath(dir), created);
  return created;
}

export function loadDevicesSync(dir: string): DeviceFile {
  try {
    const parsed = parseDevices(
      JSON.parse(readFileSync(devicesPath(dir), "utf8")),
    );
    if (parsed) return parsed;
  } catch (err) {
    if (isPermissionError(err)) throw unreadableSetup(err);
  }
  return emptyDevices();
}

function isPermissionError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err.code === "EACCES" || err.code === "EPERM")
  );
}

function unreadableSetup(err: unknown): DeviceStoreError {
  const detail = err instanceof Error ? err.message : "permission denied";
  return new DeviceStoreError(
    500,
    `setup files are not readable by the runner user (${detail})`,
  );
}

async function saveDevices(dir: string, file: DeviceFile): Promise<void> {
  await writeJson(devicesPath(dir), file);
}

export async function loadEnrollments(dir: string): Promise<EnrollmentFile> {
  try {
    const parsed = parseEnrollments(
      JSON.parse(await readFile(enrollmentsPath(dir), "utf8")),
    );
    if (parsed) return pruneEnrollments(parsed);
  } catch (err) {
    if (isPermissionError(err)) throw unreadableSetup(err);
  }
  return emptyEnrollments();
}

async function saveEnrollments(
  dir: string,
  file: EnrollmentFile,
): Promise<void> {
  await writeJson(enrollmentsPath(dir), pruneEnrollments(file));
}

function pruneEnrollments(file: EnrollmentFile): EnrollmentFile {
  const now = Date.now();
  const invites = file.invites.filter((invite) => {
    if (invite.delivery) return true;
    return invite.expiresAt > now;
  });
  const bootstrap =
    file.bootstrap && file.bootstrap.expiresAt > now
      ? file.bootstrap
      : undefined;
  const browser =
    file.browser && file.browser.expiresAt > now ? file.browser : undefined;
  return {
    version: 1,
    invites,
    ...(bootstrap ? { bootstrap } : {}),
    ...(browser ? { browser } : {}),
  };
}

export function activeDevices(file: DeviceFile): DeviceRecord[] {
  return file.devices.filter((device) => !device.revokedAt);
}

function normalizeName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new DeviceStoreError(400, "device name required");
  return name.slice(0, 64);
}

function addDevice(
  file: DeviceFile,
  name: string,
): { file: DeviceFile; deviceId: string; token: string } {
  const token = randomBytes(32).toString("base64url");
  const device: DeviceRecord = {
    id: newId("dev"),
    name,
    tokenHash: hashSecret(token),
    createdAt: nowIso(),
  };
  return {
    file: { ...file, devices: [...file.devices, device] },
    deviceId: device.id,
    token,
  };
}

export async function countActiveDevices(dir: string): Promise<number> {
  const file = await loadDevices(dir);
  return activeDevices(file).length;
}

export async function currentBootstrapCode(
  dir: string,
): Promise<string | undefined> {
  const file = await loadEnrollments(dir);
  return file.bootstrap?.code;
}

export async function issueBootstrap(
  dir: string,
  kind: "bootstrap" | "recover" = "bootstrap",
): Promise<string> {
  if (kind === "bootstrap" && (await countActiveDevices(dir)) > 0) {
    throw new DeviceStoreError(
      409,
      "devices already enrolled; add one from HelmCode, or run setup:recover",
    );
  }
  const code = generateEnrollmentCode();
  const enrollments = await loadEnrollments(dir);
  const next: EnrollmentFile = {
    ...enrollments,
    bootstrap: {
      code,
      kind,
      expiresAt: Date.now() + ENROLL_TTL_MS,
      createdAt: nowIso(),
    },
  };
  await saveEnrollments(dir, next);
  return code;
}

export async function recoverDevices(dir: string): Promise<string> {
  const file = await loadDevices(dir);
  const revokedAt = nowIso();
  await saveDevices(dir, {
    ...file,
    devices: file.devices.map((device) =>
      device.revokedAt ? device : { ...device, revokedAt },
    ),
  });
  const enrollments = await loadEnrollments(dir);
  await saveEnrollments(dir, { ...enrollments, invites: [] });
  return issueBootstrap(dir, "recover");
}

export async function enroll(
  dir: string,
  codeRaw: string,
  deviceNameRaw: string,
): Promise<EnrollResult> {
  const code = normalizeEnrollmentCode(codeRaw);
  if (!code) throw new DeviceStoreError(400, "invalid or expired setup code");
  const name = normalizeName(deviceNameRaw);
  const enrollments = await loadEnrollments(dir);
  const devices = await loadDevices(dir);

  if (
    enrollments.bootstrap &&
    enrollments.bootstrap.expiresAt > Date.now() &&
    codesEqual(enrollments.bootstrap.code, code)
  ) {
    const created = addDevice(devices, name);
    await saveDevices(dir, created.file);
    const rest: EnrollmentFile = { ...enrollments, invites: enrollments.invites };
    delete rest.bootstrap;
    await saveEnrollments(dir, rest);
    return {
      status: "complete",
      deviceId: created.deviceId,
      token: created.token,
      runnerId: created.file.runnerId,
    };
  }

  const index = enrollments.invites.findIndex(
    (invite) =>
      !invite.denied &&
      !invite.delivery &&
      invite.expiresAt > Date.now() &&
      codesEqual(invite.code, code),
  );
  if (index < 0) {
    throw new DeviceStoreError(400, "invalid or expired setup code");
  }
  const invite = enrollments.invites[index]!;
  if (invite.request) {
    throw new DeviceStoreError(
      409,
      "a device is already waiting for approval on this code",
    );
  }
  const nextInvite: InviteRecord = {
    ...invite,
    request: { deviceName: name, requestedAt: nowIso() },
  };
  const invites = enrollments.invites.slice();
  invites[index] = nextInvite;
  await saveEnrollments(dir, { ...enrollments, invites });
  return {
    status: "pending",
    enrollmentId: invite.id,
    expiresAt: invite.expiresAt,
  };
}

export async function createInvite(
  dir: string,
  url?: string,
): Promise<{ code: string; expiresAt: number; url?: string }> {
  if ((await countActiveDevices(dir)) === 0) {
    throw new DeviceStoreError(409, "enroll a device before inviting another");
  }
  const enrollments = await loadEnrollments(dir);
  const invites = enrollments.invites.map((invite) => {
    if (invite.delivery || invite.denied || invite.expiresAt <= Date.now()) {
      return invite;
    }
    return { ...invite, denied: true };
  });
  const code = generateEnrollmentCode();
  const created: InviteRecord = {
    id: newId("enr"),
    code,
    expiresAt: Date.now() + ENROLL_TTL_MS,
    createdAt: nowIso(),
    ...(url ? { url } : {}),
  };
  await saveEnrollments(dir, {
    ...enrollments,
    invites: [...invites, created],
  });
  return {
    code,
    expiresAt: created.expiresAt,
    ...(url ? { url } : {}),
  };
}

export async function listPending(dir: string): Promise<PendingEnrollment[]> {
  const enrollments = await loadEnrollments(dir);
  const now = Date.now();
  return enrollments.invites.flatMap((invite) => {
    if (!invite.request || invite.denied || invite.delivery) return [];
    if (invite.expiresAt <= now) return [];
    return [
      {
        id: invite.id,
        deviceName: invite.request.deviceName,
        createdAt: invite.request.requestedAt,
        expiresAt: invite.expiresAt,
      },
    ];
  });
}

export async function approveEnrollment(
  dir: string,
  enrollmentId: string,
): Promise<{ deviceId: string; deviceName: string }> {
  const enrollments = await loadEnrollments(dir);
  const index = enrollments.invites.findIndex(
    (invite) => invite.id === enrollmentId,
  );
  if (index < 0) throw new DeviceStoreError(404, "enrollment not found");
  const invite = enrollments.invites[index]!;
  if (invite.denied) throw new DeviceStoreError(409, "enrollment was denied");
  if (invite.expiresAt <= Date.now()) {
    throw new DeviceStoreError(400, "invalid or expired setup code");
  }
  if (!invite.request) {
    throw new DeviceStoreError(409, "no device is waiting on this code");
  }
  if (invite.delivery) {
    return {
      deviceId: invite.delivery.deviceId,
      deviceName: invite.request.deviceName,
    };
  }
  const devices = await loadDevices(dir);
  const created = addDevice(devices, invite.request.deviceName);
  await saveDevices(dir, created.file);
  const next: InviteRecord = {
    ...invite,
    delivery: {
      deviceId: created.deviceId,
      token: created.token,
      runnerId: created.file.runnerId,
    },
  };
  const invites = enrollments.invites.slice();
  invites[index] = next;
  await saveEnrollments(dir, { ...enrollments, invites });
  return {
    deviceId: created.deviceId,
    deviceName: invite.request.deviceName,
  };
}

export async function denyEnrollment(
  dir: string,
  enrollmentId: string,
): Promise<void> {
  const enrollments = await loadEnrollments(dir);
  const index = enrollments.invites.findIndex(
    (invite) => invite.id === enrollmentId,
  );
  if (index < 0) throw new DeviceStoreError(404, "enrollment not found");
  const invite = enrollments.invites[index]!;
  if (invite.delivery) {
    throw new DeviceStoreError(409, "enrollment already approved");
  }
  const invites = enrollments.invites.slice();
  invites[index] = { ...invite, denied: true };
  await saveEnrollments(dir, { ...enrollments, invites });
}

export async function pollEnrollment(
  dir: string,
  enrollmentId: string,
): Promise<
  | { status: "pending"; expiresAt: number }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "complete";
      deviceId: string;
      token: string;
      runnerId: string;
    }
> {
  const enrollments = await loadEnrollments(dir);
  const index = enrollments.invites.findIndex(
    (invite) => invite.id === enrollmentId,
  );
  if (index < 0) throw new DeviceStoreError(404, "enrollment not found");
  const invite = enrollments.invites[index]!;
  if (invite.delivery) {
    const delivery = invite.delivery;
    const invites = enrollments.invites.filter(
      (item) => item.id !== enrollmentId,
    );
    await saveEnrollments(dir, { ...enrollments, invites });
    return {
      status: "complete",
      deviceId: delivery.deviceId,
      token: delivery.token,
      runnerId: delivery.runnerId,
    };
  }
  if (invite.denied) return { status: "denied" };
  if (invite.expiresAt <= Date.now()) return { status: "expired" };
  return { status: "pending", expiresAt: invite.expiresAt };
}

export function matchTokenSync(
  dir: string,
  token: string,
): { id: string; runnerId: string } | null {
  if (!token) return null;
  const file = loadDevicesSync(dir);
  const hashed = hashSecret(token);
  let found: DeviceRecord | null = null;
  for (const device of activeDevices(file)) {
    if (hashesEqual(hashed, device.tokenHash)) found = device;
  }
  if (!found) return null;
  return { id: found.id, runnerId: file.runnerId };
}

export async function touchDevice(dir: string, id: string): Promise<void> {
  const file = await loadDevices(dir);
  const index = file.devices.findIndex((device) => device.id === id);
  if (index < 0) return;
  const device = file.devices[index]!;
  const seen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
  if (Date.now() - seen < 60_000) return;
  const devices = file.devices.slice();
  devices[index] = { ...device, lastSeenAt: nowIso() };
  await saveDevices(dir, { ...file, devices });
}

export async function listDeviceViews(
  dir: string,
  currentId?: string,
): Promise<{ runnerId: string; devices: DeviceView[] }> {
  const file = await loadDevices(dir);
  return {
    runnerId: file.runnerId,
    devices: activeDevices(file).map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
      current: device.id === currentId,
    })),
  };
}

export async function revokeDevice(dir: string, id: string): Promise<void> {
  const file = await loadDevices(dir);
  const target = file.devices.find((device) => device.id === id);
  if (!target || target.revokedAt) {
    throw new DeviceStoreError(404, "device not found");
  }
  if (activeDevices(file).length <= 1) {
    throw new DeviceStoreError(
      409,
      "cannot revoke the last device; run setup:recover on the runner",
    );
  }
  const devices = file.devices.map((device) =>
    device.id === id ? { ...device, revokedAt: nowIso() } : device,
  );
  await saveDevices(dir, { ...file, devices });
}

export async function runnerIdOf(dir: string): Promise<string> {
  const file = await loadDevices(dir);
  return file.runnerId;
}

export async function issueBrowserGrant(dir: string): Promise<string> {
  const code = generateEnrollmentCode();
  const enrollments = await loadEnrollments(dir);
  await saveEnrollments(dir, {
    ...enrollments,
    browser: { code, expiresAt: Date.now() + ENROLL_TTL_MS },
  });
  return code;
}

/** Bootstrap code unlocks the setup page without being consumed. A browser grant is single-use. */
export async function unlockBrowser(
  dir: string,
  codeRaw: string,
): Promise<boolean> {
  const code = normalizeEnrollmentCode(codeRaw);
  if (!code) return false;
  const enrollments = await loadEnrollments(dir);
  if (
    enrollments.bootstrap &&
    enrollments.bootstrap.expiresAt > Date.now() &&
    codesEqual(enrollments.bootstrap.code, code)
  ) {
    return true;
  }
  if (
    enrollments.browser &&
    enrollments.browser.expiresAt > Date.now() &&
    codesEqual(enrollments.browser.code, code)
  ) {
    const next: EnrollmentFile = { ...enrollments };
    delete next.browser;
    await saveEnrollments(dir, next);
    return true;
  }
  return false;
}

function codesEqual(expected: string, got: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(got);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
