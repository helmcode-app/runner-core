/**
 * Live smoke: /v1/sessions create → prompt → SSE against real `opencode acp`.
 * Loads AGENT_* from repo `.env`. Never prints secrets.
 *
 *   npx tsx scripts/acp-smoke.ts
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { startOpenCore } from "../src/modes/open-core/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1);
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function redact(obj: unknown): unknown {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (/key|token|secret|password/i.test(k) && typeof v === "string") {
      next[k] = `set(len=${v.length})`;
    } else {
      next[k] = redact(v);
    }
  }
  return next;
}

async function readSseUntil(
  url: string,
  pred: (ev: { type: string; data: unknown }) => boolean,
  timeoutMs: number,
): Promise<Array<{ type: string; data: unknown }>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events: Array<{ type: string; data: unknown }> = [];
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE ${res.status} ${await res.text()}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let eventType = "message";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          let data: unknown = raw;
          try {
            data = JSON.parse(raw);
          } catch {
            /* keep raw */
          }
          const ev = { type: eventType, data };
          events.push(ev);
          if (pred(ev)) {
            ac.abort();
            return events;
          }
          eventType = "message";
        } else if (line === "") {
          eventType = "message";
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const envFile = parseDotEnv(
    await readFile(path.join(REPO_ROOT, ".env"), "utf8"),
  );
  const apiKey = envFile.AGENT_API_KEY?.trim();
  const provider = envFile.AGENT_PROVIDER?.trim() || "opencode-go";
  const model = envFile.AGENT_DEFAULT_MODEL?.trim() || "opencode-go/glm-5.1";
  if (!apiKey) throw new Error("AGENT_API_KEY missing in .env");

  const root = await mkdtemp(path.join(os.tmpdir(), "helm-acp-smoke-"));
  const repoDir = path.join(root, "repo");
  const workspaces = path.join(root, "workspaces");
  const ocHome = path.join(root, "oc-home");
  await mkdir(repoDir, { recursive: true });
  await mkdir(workspaces, { recursive: true });
  await mkdir(ocHome, { recursive: true });
  spawnSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  await writeFile(path.join(repoDir, "README.md"), "# smoke\n", "utf8");
  spawnSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@helmcode.app",
      "commit",
      "-m",
      "init",
    ],
    { cwd: repoDir, stdio: "ignore" },
  );

  const config = loadConfig({
    HELM_MODE: "open-core",
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_LEVEL: "info",
    MAIN_REPO_PATH: repoDir,
    WORKSPACES_PATH: workspaces,
    VFS_ENABLED: "false",
    TERMINAL_ENABLED: "false",
    SESSIONS_ENABLED: "true",
    AGENT_HARNESS: "opencode",
    AGENT_PROVIDER: provider,
    AGENT_API_KEY: apiKey,
    AGENT_DEFAULT_MODEL: model,
  });

  const logger = createLogger(config);
  console.log("starting open-core + opencode acp…");
  const svc = await startOpenCore(config, logger, {
    installSignalHandlers: false,
    harnessOverlay: {
      bin: "/tmp/helm-opencode-prefix/bin/opencode",
      prefix: "/tmp/helm-opencode-prefix",
      home: ocHome,
      updateIntervalHours: 0,
    },
  });
  const base = svc.baseUrl;
  console.log("baseUrl", base);

  try {
    const health = await (await fetch(`${base}/health`)).json();
    console.log("GET /health", JSON.stringify(redact(health)));

    const sessHealth = await (await fetch(`${base}/v1/sessions/health`)).json();
    console.log("GET /v1/sessions/health", JSON.stringify(redact(sessHealth)));

    const models = await (await fetch(`${base}/v1/sessions/models`)).json();
    console.log("GET /v1/sessions/models", JSON.stringify(redact(models)));

    const createdRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "acp-smoke" }),
    });
    const createdText = await createdRes.text();
    console.log("POST /v1/sessions", createdRes.status, createdText);
    if (!createdRes.ok) throw new Error("create session failed");
    const created = JSON.parse(createdText) as {
      session: { id: string; status: string };
    };
    const id = created.session.id;

    const ssePromise = readSseUntil(
      `${base}/v1/sessions/events`,
      (ev) =>
        ev.type === "session.turn.completed" ||
        ev.type === "session.turn.cancelled" ||
        ev.type === "session.error",
      120_000,
    ).catch((err) => {
      console.log("SSE ended:", err instanceof Error ? err.message : err);
      return [] as Array<{ type: string; data: unknown }>;
    });

    await new Promise((r) => setTimeout(r, 300));

    const promptRes = await fetch(`${base}/v1/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Reply with exactly the single word pong and nothing else.",
        mode: "agent",
        model,
      }),
    });
    const promptText = await promptRes.text();
    console.log("POST prompt", promptRes.status, promptText);
    if (!promptRes.ok) throw new Error("prompt failed");

    const events = await ssePromise;
    console.log(
      "SSE events",
      events.map((e) => e.type).join(" → ") || "(none)",
    );
    for (const ev of events) {
      const data = ev.data as Record<string, unknown> | undefined;
      if (
        ev.type === "session.message.delta" &&
        data &&
        typeof data.text === "string"
      ) {
        console.log("  delta:", JSON.stringify(data.text));
      } else if (ev.type === "session.error") {
        console.log("  error:", JSON.stringify(redact(data)));
      } else if (ev.type === "session.turn.completed") {
        console.log("  completed:", JSON.stringify(redact(data)));
      }
    }

    const histRes = await fetch(`${base}/v1/sessions/${id}/history`);
    const hist = (await histRes.json()) as {
      entries?: Array<{
        kind: string;
        role: string;
        text?: string;
        done?: boolean;
      }>;
      session?: { status: string };
    };
    console.log(
      "history status",
      hist.session?.status,
      "entries",
      hist.entries?.length,
    );
    for (const e of hist.entries ?? []) {
      const text = (e.text ?? "").slice(0, 240);
      console.log(`  [${e.kind}/${e.role}${e.done ? "" : "*"}] ${text}`);
    }

    const del = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    console.log("DELETE session", del.status);

    const assistant = (hist.entries ?? []).find(
      (e) =>
        e.kind === "message" && e.role === "assistant" && (e.text ?? "").trim(),
    );
    if (!assistant) {
      throw new Error("smoke failed: no assistant message in history");
    }
    console.log("SMOKE OK");
  } finally {
    await svc.close();
    console.log("closed", root);
  }
}

main().catch((err) => {
  console.error(
    "SMOKE FAILED",
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  process.exit(1);
});
