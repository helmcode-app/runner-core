import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve helm-vfs binary for local monorepo dev and container images.
 *
 * Order: HELM_VFS_BIN → cwd-relative → monorepo services/vfs/bin → /app/bin.
 */
export function resolveHelmVfsBinary(): string {
  if (process.env.HELM_VFS_BIN) {
    return process.env.HELM_VFS_BIN;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  // services/runner/src/vfs → services/vfs/bin
  const candidates = [
    path.join(process.cwd(), "bin", "helm-vfs"),
    path.join(process.cwd(), "services", "vfs", "bin", "helm-vfs"),
    path.resolve(here, "..", "..", "..", "vfs", "bin", "helm-vfs"),
    path.resolve(here, "..", "..", "..", "..", "services", "vfs", "bin", "helm-vfs"),
    "/app/bin/helm-vfs",
  ];

  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // try next
    }
  }

  return "helm-vfs";
}
