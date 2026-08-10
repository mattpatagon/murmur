export class UnknownAgentError extends Error {
  public constructor(agentId: string) {
    super(`Unknown agent '${agentId}'. Register it first.`);
    this.name = "UnknownAgentError";
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(key: string) {
    super(`Idempotency key '${key}' was already used for a different message`);
    this.name = "IdempotencyConflictError";
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
