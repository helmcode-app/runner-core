import type { AppConfig } from "../config.js";
import { resolveModeMapping, normalizeMode } from "./mode.js";
import { parseModelRef, toOpenCodeModelField } from "./model.js";
import type { OpenCodeClient } from "./client.js";
import type { OpenCodeMode, PromptAccepted, PromptBody } from "./types.js";

/**
 * Build OpenCode message body and fire `POST /session/:id/prompt_async`.
 * Returns immediately; work continues on the OpenCode daemon offline-safe.
 */
export async function submitPromptAsync(
  client: OpenCodeClient,
  config: AppConfig,
  sessionId: string,
  body: PromptBody,
  signal?: AbortSignal,
): Promise<PromptAccepted> {
  const prompt = body.prompt?.trim();
  if (!prompt) throw new Error("prompt is required");

  const mode: OpenCodeMode = normalizeMode(body.mode);
  const modeEnv: {
    agentName?: string;
    planAgentName?: string;
    askAgentName?: string;
  } = {};
  if (config.OPENCODE_AGENT_NAME) modeEnv.agentName = config.OPENCODE_AGENT_NAME;
  if (config.OPENCODE_PLAN_AGENT) modeEnv.planAgentName = config.OPENCODE_PLAN_AGENT;
  if (config.OPENCODE_ASK_AGENT) modeEnv.askAgentName = config.OPENCODE_ASK_AGENT;
  const mapping = resolveModeMapping(mode, modeEnv);

  const modelRef = parseModelRef(body.model ?? config.OPENCODE_DEFAULT_MODEL);
  const modelField = toOpenCodeModelField(modelRef);

  const systemParts = [mapping.systemPreamble, body.system?.trim()].filter(
    Boolean,
  ) as string[];
  if (body.contextPaths?.length) {
    systemParts.push(
      `Preferred context paths (hint): ${body.contextPaths.join(", ")}`,
    );
  }

  /** OpenCode message part: text user content. */
  const parts: Array<{ type: string; text: string }> = [
    { type: "text", text: prompt },
  ];

  const upstreamBody: Record<string, unknown> = {
    agent: mapping.agent,
    parts,
  };
  if (modelField) {
    upstreamBody.model = modelField;
  } else if (modelRef?.modelID) {
    // Bare model id — pass through as string for builds that accept it.
    upstreamBody.model = modelRef.raw;
  }
  if (systemParts.length > 0) {
    upstreamBody.system = systemParts.join("\n\n");
  }
  if (body.messageID) {
    upstreamBody.messageID = body.messageID;
  }

  // POST /session/:id/prompt_async  → 204
  await client.promptAsync(sessionId, upstreamBody, signal);

  return {
    sessionId,
    status: "accepted",
    mode,
    ...(modelRef?.raw !== undefined ? { model: modelRef.raw } : {}),
    ...(mapping.agent ? { agent: mapping.agent } : {}),
  };
}
