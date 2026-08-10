import {
  AgentCapacityError,
  NoticeCapacityError,
  StorageCorruptionError,
} from "../domain/errors.js";

function stringProperty(error: unknown, property: string): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value: unknown = Reflect.get(error, property);
  return typeof value === "string" ? value : null;
}

export function normalizePostgresStorageError(error: unknown): unknown {
  const code: string | null = stringProperty(error, "code");
  const message: string | null = stringProperty(error, "message");
  if (code === "54000" && message === "tenant agent quota exceeded") {
    return new AgentCapacityError();
  }
  if (code === "54000" && message === "tenant retained-notice quota exceeded") {
    return new NoticeCapacityError();
  }
  if (code === "XX001") {
    return new StorageCorruptionError("tenant resource accounting", error);
  }
  const constraint: string | null = stringProperty(error, "constraint_name");
  if (
    code === "23514" &&
    constraint !== null &&
    (constraint.startsWith("agent_sessions_") || constraint.startsWith("notices_"))
  ) {
    return new StorageCorruptionError("agent lifecycle data", error);
  }
  return error;
}
