import {
  AgentCapacityError,
  FeedbackCapacityError,
  NoticeCapacityError,
  StorageCorruptionError,
} from "../domain/errors.js";

const SAFE_E2EE_DATABASE_MESSAGES: ReadonlySet<string> = new Set<string>([
  "agent E2E identity has active encryption work",
  "E2E enforcement requires a positive trust-policy version",
  "expected E2E root does not match current identity",
  "identity reset reason must contain 10 to 500 characters",
  "plaintext message writes are disabled for this tenant",
  "tenant administrator credential rejected",
  "tenant E2E enforcement prerequisites are incomplete",
  "tenant E2E rollback is unavailable while ciphertext is retained",
  "tenant E2E state changed before transition",
  "tenant E2E transition is invalid from the current state",
  "unknown tenant E2E transition action",
]);

function stringProperty(error: unknown, property: string): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value: unknown = Reflect.get(error, property);
  return typeof value === "string" ? value : null;
}

export function normalizePostgresStorageError(error: unknown): unknown {
  const code: string | null = stringProperty(error, "code");
  const message: string | null = stringProperty(error, "message");
  if (
    code === "54000" &&
    (message === "tenant agent quota exceeded" ||
      message === "tenant retained-agent quota exceeded")
  ) {
    return new AgentCapacityError();
  }
  if (code === "54000" && message === "tenant retained-notice quota exceeded") {
    return new NoticeCapacityError();
  }
  if (code === "54000" && message === "tenant retained-feedback quota exceeded") {
    return new FeedbackCapacityError();
  }
  if (code === "XX001") {
    return new StorageCorruptionError("tenant resource accounting", error);
  }
  const constraint: string | null = stringProperty(error, "constraint_name");
  if (code !== null && message !== null && SAFE_E2EE_DATABASE_MESSAGES.has(message)) {
    return new Error(message);
  }
  if (
    constraint !== null &&
    (constraint.startsWith("e2ee_") || constraint.startsWith("tenant_e2ee_"))
  ) {
    return new Error("Encrypted storage rejected the request");
  }
  if (code === "23514" && constraint !== null && constraint.startsWith("feedback_submissions_")) {
    return new StorageCorruptionError("feedback submission", error);
  }
  if (
    code === "23514" &&
    constraint !== null &&
    (constraint.startsWith("agent_sessions_") || constraint.startsWith("notices_"))
  ) {
    return new StorageCorruptionError("agent lifecycle data", error);
  }
  return error;
}
