export class UnknownAgentError extends Error {
  public constructor(agentId: string) {
    super(`Unknown agent '${agentId}'. Register it first.`);
    this.name = "UnknownAgentError";
  }
}

export class AgentClosedError extends Error {
  public constructor(agentId: string) {
    super(`Agent '${agentId}' is closed. Register it again before creating new work.`);
    this.name = "AgentClosedError";
  }
}

export class StaleAgentGenerationError extends Error {
  public constructor(agentId: string) {
    super(`Agent '${agentId}' changed generation. Refresh its lifecycle state and retry.`);
    this.name = "StaleAgentGenerationError";
  }
}

export class AgentCapacityError extends Error {
  public constructor() {
    super("Open agent capacity reached. Close an inactive identity before registering another.");
    this.name = "AgentCapacityError";
  }
}

export class NoticeCapacityError extends Error {
  public constructor() {
    super("Retained notice capacity reached. Resolve or withdraw old notices before posting.");
    this.name = "NoticeCapacityError";
  }
}

export class FeedbackCapacityError extends Error {
  public constructor() {
    super(
      "Retained feedback capacity reached. Contact a Murmur maintainer before submitting more feedback.",
    );
    this.name = "FeedbackCapacityError";
  }
}

export class NoticeStateConflictError extends Error {
  public constructor() {
    super("Notice is no longer open. Refresh it before changing its state.");
    this.name = "NoticeStateConflictError";
  }
}

export class NoticeOwnershipError extends Error {
  public constructor() {
    super("Only the creating agent identity can withdraw this notice.");
    this.name = "NoticeOwnershipError";
  }
}

export class AgentAuthorityError extends Error {
  public constructor() {
    super("The authenticated authority cannot act as this agent");
    this.name = "AgentAuthorityError";
  }
}

export class AgentAuthorityConflictError extends Error {
  public constructor() {
    super("The agent ID is reserved for a different authority");
    this.name = "AgentAuthorityConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(key: string) {
    super(`Idempotency key '${key}' was already used for a different message`);
    this.name = "IdempotencyConflictError";
  }
}

export class FeedbackIdempotencyConflictError extends Error {
  public constructor(key: string) {
    super(`Idempotency key '${key}' was already used for different feedback`);
    // biome-ignore lint/security/noSecrets: Stable error class identifier, not credential material.
    this.name = "FeedbackIdempotencyConflictError";
  }
}

export class IdempotencyWinnerMissingError extends Error {
  public constructor() {
    super("Idempotent message conflict had no stored winner");
    this.name = "IdempotencyWinnerMissingError";
  }
}

export class StorageCorruptionError extends Error {
  public constructor(entity: string, cause: unknown) {
    super(`Stored ${entity} failed runtime validation`, { cause });
    this.name = "StorageCorruptionError";
  }
}

export class UnsupportedDatabaseError extends Error {
  public constructor(protocol: string) {
    super(
      `Unsupported MURMUR_DATABASE_URL protocol '${protocol}'. ` +
        "This build supports postgres:, postgresql:, sqlite:, and file:.",
    );
    this.name = "UnsupportedDatabaseError";
  }
}
