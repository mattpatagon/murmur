import { expect, test } from "bun:test";

import {
  AgentCapacityError,
  FeedbackCapacityError,
  NoticeCapacityError,
  StorageCorruptionError,
} from "../src/domain/errors.js";
import { normalizePostgresStorageError } from "../src/storage/postgres-storage-errors.js";

function postgresError(code: string, message: string, constraintName?: string): Error {
  const error: Error = new Error(message);
  Reflect.set(error, "code", code);
  if (constraintName !== undefined) Reflect.set(error, "constraint_name", constraintName);
  return error;
}

test("Postgres quota and accounting failures become stable domain errors", (): void => {
  expect(
    normalizePostgresStorageError(postgresError("54000", "tenant agent quota exceeded")),
  ).toBeInstanceOf(AgentCapacityError);
  expect(
    normalizePostgresStorageError(postgresError("54000", "tenant retained-notice quota exceeded")),
  ).toBeInstanceOf(NoticeCapacityError);
  expect(
    normalizePostgresStorageError(
      postgresError("54000", "tenant retained-feedback quota exceeded"),
    ),
  ).toBeInstanceOf(FeedbackCapacityError);
  expect(
    normalizePostgresStorageError(
      postgresError("XX001", "tenant notice quota accounting inconsistent"),
    ),
  ).toBeInstanceOf(StorageCorruptionError);
});

test("new lifecycle constraints never expose schema names while unrelated errors survive", (): void => {
  const constraint: unknown = normalizePostgresStorageError(
    postgresError("23514", "raw database detail", "notices_expiry_bounds"),
  );
  expect(constraint).toBeInstanceOf(StorageCorruptionError);
  expect(constraint).toHaveProperty(
    "message",
    "Stored agent lifecycle data failed runtime validation",
  );
  const feedbackConstraint: unknown = normalizePostgresStorageError(
    postgresError("23514", "raw feedback detail", "feedback_submissions_type_known"),
  );
  expect(feedbackConstraint).toHaveProperty(
    "message",
    "Stored feedback submission failed runtime validation",
  );

  const unrelated: Error = postgresError("23505", "existing compatibility error");
  expect(normalizePostgresStorageError(unrelated)).toBe(unrelated);
});

test("E2E database failures preserve allowlisted guidance and hide schema details", (): void => {
  const lifecycle: unknown = normalizePostgresStorageError(
    postgresError("55000", "tenant E2E rollback is unavailable while ciphertext is retained"),
  );
  expect(lifecycle).toHaveProperty(
    "message",
    "tenant E2E rollback is unavailable while ciphertext is retained",
  );
  const constraint: unknown = normalizePostgresStorageError(
    postgresError("23514", "internal check detail", "e2ee_messages_internal_check"),
  );
  expect(constraint).toHaveProperty("message", "Encrypted storage rejected the request");
});
