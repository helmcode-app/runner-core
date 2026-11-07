import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "../http/json.js";
import type { SetupController } from "./controller.js";
import { SetupHttpError } from "./controller.js";
import { renderSetupPage } from "./page.js";

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function setSetupCookie(res: ServerResponse, secret: string): void {
  res.setHeader(
    "set-cookie",
    `helm_setup=${secret}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`,
  );
}

function fail(res: ServerResponse, err: unknown): boolean {
  if (err instanceof SetupHttpError) {
    sendJson(res, err.status, { error: err.message });
    return true;
  }
  return false;
}

/** Enrolled device Bearer (iPad runner page) or setup-page operator cookie. */
function canManageRepo(setup: SetupController, req: IncomingMessage): boolean {
  return setup.authorizeDevice(req) || setup.isOperator(req);
}

export async function handleSetupHttp(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  setup: SetupController,
): Promise<boolean> {
  const pathname = url.pathname;

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    sendHtml(res, renderSetupPage());
    return true;
  }

  if (!pathname.startsWith("/v1/setup")) return false;

  try {
    if (method === "GET" && pathname === "/v1/setup") {
      sendJson(res, 200, await setup.publicStatus());
      return true;
    }

    if (method === "POST" && pathname === "/v1/setup/enroll") {
      const body = (await readJson(req)) as {
        code?: unknown;
        deviceName?: unknown;
      };
      sendJson(
        res,
        200,
        await setup.enrollDevice(
          req,
          typeof body.code === "string" ? body.code : "",
          typeof body.deviceName === "string" ? body.deviceName : "",
        ),
      );
      return true;
    }

    if (method === "POST" && pathname === "/v1/setup/browser") {
      const body = (await readJson(req)) as { code?: unknown };
      const secret = await setup.unlockBrowser(
        req,
        typeof body.code === "string" ? body.code : "",
      );
      setSetupCookie(res, secret);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const enrollmentPoll = pathname.match(
      /^\/v1\/setup\/enrollments\/([^/]+)$/,
    );
    if (method === "GET" && enrollmentPoll?.[1]) {
      sendJson(res, 200, await setup.poll(decodeURIComponent(enrollmentPoll[1])));
      return true;
    }

    if (!setup.authorizeDevice(req) && !setup.isOperator(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    if (method === "GET" && pathname === "/v1/setup/session") {
      if (!canManageRepo(setup, req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return true;
      }
      sendJson(res, 200, setup.operatorStatus());
      return true;
    }

    if (canManageRepo(setup, req)) {
      if (method === "POST" && pathname === "/v1/setup/github/start") {
        sendJson(res, 200, await setup.startGithub());
        return true;
      }
      if (method === "GET" && pathname === "/v1/setup/github/poll") {
        sendJson(res, 200, await setup.pollGithub());
        return true;
      }
      if (method === "GET" && pathname === "/v1/setup/github/repos") {
        sendJson(res, 200, { repos: await setup.listRepos() });
        return true;
      }
      if (method === "POST" && pathname === "/v1/setup/github/clone") {
        const body = (await readJson(req)) as {
          owner?: unknown;
          repo?: unknown;
          ref?: unknown;
        };
        const cloned = await setup.cloneRepo({
          owner: typeof body.owner === "string" ? body.owner : "",
          repo: typeof body.repo === "string" ? body.repo : "",
          ...(typeof body.ref === "string" ? { ref: body.ref } : {}),
        });
        sendJson(res, 200, setup.operatorStatus({ workspaceId: cloned.workspaceId }));
        return true;
      }
    }

    if (!setup.authorizeDevice(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    if (method === "POST" && pathname === "/v1/setup/invites") {
      const body = (await readJson(req)) as { url?: unknown };
      const raw = typeof body.url === "string" ? body.url.trim() : "";
      sendJson(
        res,
        200,
        raw ? await setup.inviteDevice(raw) : await setup.inviteDevice(),
      );
      return true;
    }

    if (method === "GET" && pathname === "/v1/setup/devices") {
      sendJson(res, 200, await setup.devices(req));
      return true;
    }

    const deviceRevoke = pathname.match(/^\/v1\/setup\/devices\/([^/]+)$/);
    if (method === "DELETE" && deviceRevoke?.[1]) {
      await setup.revoke(decodeURIComponent(deviceRevoke[1]));
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && pathname === "/v1/setup/enrollments") {
      sendJson(res, 200, { enrollments: await setup.pendingEnrollments() });
      return true;
    }

    const enrollmentAction = pathname.match(
      /^\/v1\/setup\/enrollments\/([^/]+)\/(approve|deny)$/,
    );
    if (method === "POST" && enrollmentAction?.[1] && enrollmentAction[2]) {
      const id = decodeURIComponent(enrollmentAction[1]);
      if (enrollmentAction[2] === "approve") {
        sendJson(res, 200, await setup.approve(id));
      } else {
        await setup.deny(id);
        sendJson(res, 200, { ok: true });
      }
      return true;
    }

    if (method === "POST" && pathname === "/v1/setup/ws-tickets") {
      sendJson(res, 200, setup.issueWsTicket());
      return true;
    }

    sendJson(res, 404, { error: "not found" });
    return true;
  } catch (err) {
    if (fail(res, err)) return true;
    throw err;
  }
}
