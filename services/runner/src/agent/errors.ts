/** Agent gateway / ACP runtime errors. */

export class AgentRuntimeError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status = 502, body?: unknown) {
    super(message);
    this.name = "AgentRuntimeError";
    this.status = status;
    this.body = body;
  }
}

export class AgentNotFoundError extends AgentRuntimeError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, 404);
    this.name = "AgentNotFoundError";
  }
}

export class AgentCapabilityError extends AgentRuntimeError {
  constructor(message: string) {
    super(message, 501);
    this.name = "AgentCapabilityError";
  }
}
