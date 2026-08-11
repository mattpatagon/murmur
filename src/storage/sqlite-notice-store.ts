import type { Database } from "bun:sqlite";

import {
  IdempotencyConflictError,
  NoticeCapacityError,
  NoticeOwnershipError,
  NoticeStateConflictError,
} from "../domain/errors.js";
import {
  MAX_NOTICE_CONTENT_BYTES,
  MAX_RETAINED_NOTICES,
  NOTICE_AUDIT_DAYS,
  NoticeId,
} from "../domain/lifecycle-values.js";
import type { Agent } from "../domain/models.js";
import type {
  ListNoticesQuery,
  ListNoticesResult,
  Notice,
  PostNoticeCommand,
  PostNoticeResult,
  ResolveNoticeCommand,
  ResolveNoticeResult,
  WithdrawNoticeCommand,
  WithdrawNoticeResult,
} from "../domain/notice-models.js";
import { Instant } from "../domain/value-objects.js";
import { mapNoticeRow, type NoticeRow, NoticeRowSchema } from "./notice-rows.js";
import { renewSqliteSession, sqliteAgent } from "./sqlite-agent-lifecycle-store.js";

function noticeRow(database: Database, noticeId: NoticeId): NoticeRow | null {
  const raw: unknown = database
    .query<unknown, [string]>("SELECT * FROM notices WHERE notice_id = ?")
    .get(noticeId.value);
  return raw === null ? null : NoticeRowSchema.parse(raw);
}

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function existingPost(
  database: Database,
  command: PostNoticeCommand,
  now: Instant,
): PostNoticeResult | null {
  if (command.idempotencyKey === null) return null;
  const raw: unknown = database
    .query<unknown, [string, string]>(`
      SELECT * FROM notices WHERE creator_id = ? AND idempotency_key = ?
    `)
    .get(command.actorId.value, command.idempotencyKey.value);
  if (raw === null) return null;
  const row: NoticeRow = NoticeRowSchema.parse(raw);
  const storedTtl: number =
    Instant.parse(row.expires_at).toEpochMilliseconds() -
    Instant.parse(row.created_at).toEpochMilliseconds();
  const requestedTtl: number = command.expiresInHours * 60 * 60 * 1000;
  const branch: string | null = command.branchName === null ? null : command.branchName.value;
  const matches: boolean =
    row.kind === command.kind &&
    row.content === command.content.value &&
    row.repository_name === command.repositoryName.value &&
    sameNullable(row.branch_name, branch) &&
    storedTtl === requestedTtl;
  if (!matches) throw new IdempotencyConflictError(command.idempotencyKey.value);
  return { duplicate: true, notice: mapNoticeRow(row, now) };
}

function ensureNoticeCapacity(database: Database, content: string): void {
  const raw: unknown = database
    .query<unknown, []>(`
      SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes
      FROM notices
    `)
    .get();
  if (raw === null || typeof raw !== "object") throw new Error("Notice usage is invalid");
  const countValue: unknown = Reflect.get(raw, "count");
  const byteValue: unknown = Reflect.get(raw, "bytes");
  if (
    (typeof countValue !== "number" && typeof countValue !== "bigint") ||
    (typeof byteValue !== "number" && typeof byteValue !== "bigint")
  ) {
    throw new Error("Notice usage is invalid");
  }
  if (
    Number(countValue) >= MAX_RETAINED_NOTICES ||
    Number(byteValue) + Buffer.byteLength(content, "utf8") > MAX_NOTICE_CONTENT_BYTES
  ) {
    throw new NoticeCapacityError();
  }
}

export function postSqliteNotice(
  database: Database,
  command: PostNoticeCommand,
  now: Instant,
): PostNoticeResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing: PostNoticeResult | null = existingPost(database, command, now);
    if (existing !== null) {
      database.exec("COMMIT");
      return existing;
    }
    const actor: Agent = renewSqliteSession(
      database,
      command.actorId,
      command.sessionKey,
      now,
      true,
    );
    ensureNoticeCapacity(database, command.content.value);
    const noticeId: NoticeId = NoticeId.generate();
    database
      .query<
        unknown,
        [
          string,
          string,
          string,
          number,
          string,
          string | null,
          string,
          string | null,
          string,
          string,
        ]
      >(`
        INSERT INTO notices(
          notice_id, kind, creator_id, creator_generation, repository_name,
          branch_name, content, idempotency_key, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        noticeId.value,
        command.kind,
        command.actorId.value,
        actor.generation.value,
        command.repositoryName.value,
        command.branchName === null ? null : command.branchName.value,
        command.content.value,
        command.idempotencyKey === null ? null : command.idempotencyKey.value,
        now.toISOString(),
        now.addHours(command.expiresInHours).toISOString(),
      );
    const row: NoticeRow | null = noticeRow(database, noticeId);
    if (row === null) throw new Error("Inserted notice could not be read back");
    const result: PostNoticeResult = { duplicate: false, notice: mapNoticeRow(row, now) };
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function listSqliteNotices(
  database: Database,
  query: ListNoticesQuery,
  now: Instant,
): ListNoticesResult {
  sqliteAgent(database, query.actorId, now);
  if (query.sessionKey !== null) {
    renewSqliteSession(database, query.actorId, query.sessionKey, now, false);
  }
  const branch: string | null = query.branchName === null ? null : query.branchName.value;
  const kind: string | null = query.kind;
  const cursorCreatedAt: string | null =
    query.cursor === null ? null : query.cursor.createdAt.toISOString();
  const cursorNoticeId: string | null = query.cursor === null ? null : query.cursor.noticeId.value;
  const rows: unknown[] = database
    .query<
      unknown,
      [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
      ]
    >(`
      SELECT * FROM notices
      WHERE repository_name = ?
        AND (? IS NULL OR branch_name = ?)
        AND (? IS NULL OR kind = ?)
        AND (
          ? = 'all'
          OR (? = 'resolved' AND resolved_at IS NOT NULL)
          OR (? = 'withdrawn' AND withdrawn_at IS NOT NULL)
          OR (? = 'open' AND resolved_at IS NULL AND withdrawn_at IS NULL AND expires_at > ?)
          OR (? = 'expired' AND resolved_at IS NULL AND withdrawn_at IS NULL AND expires_at <= ?)
        )
        AND (
          ? IS NULL OR created_at < ? OR (created_at = ? AND notice_id > ?)
        )
      ORDER BY created_at DESC, notice_id ASC
      LIMIT ?
    `)
    .all(
      query.repositoryName.value,
      branch,
      branch,
      kind,
      kind,
      query.state,
      query.state,
      query.state,
      query.state,
      now.toISOString(),
      query.state,
      now.toISOString(),
      cursorCreatedAt,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorNoticeId,
      query.limit + 1,
    );
  const pageRows: unknown[] = rows.slice(0, query.limit);
  const notices: Notice[] = pageRows.map((row: unknown): Notice => mapNoticeRow(row, now));
  const last: Notice | undefined = notices.at(-1);
  return {
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? { createdAt: last.createdAt, noticeId: last.noticeId }
        : null,
    notices,
  };
}

function requireNotice(database: Database, noticeId: NoticeId): NoticeRow {
  const row: NoticeRow | null = noticeRow(database, noticeId);
  if (row === null) throw new Error("Unknown notice");
  return row;
}

export function resolveSqliteNotice(
  database: Database,
  command: ResolveNoticeCommand,
  now: Instant,
): ResolveNoticeResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row: NoticeRow = requireNotice(database, command.noticeId);
    if (row.repository_name !== command.repositoryName.value) throw new Error("Unknown notice");
    if (row.resolved_at !== null) {
      const result: ResolveNoticeResult = {
        alreadyResolved: true,
        notice: mapNoticeRow(row, now),
      };
      database.exec("COMMIT");
      return result;
    }
    if (row.withdrawn_at !== null || !Instant.parse(row.expires_at).isAfter(now)) {
      throw new NoticeStateConflictError();
    }
    const actor: Agent = renewSqliteSession(
      database,
      command.actorId,
      command.sessionKey,
      now,
      true,
    );
    database
      .query<unknown, [string, number, string, string, string]>(`
        UPDATE notices SET resolved_by_id = ?, resolved_by_generation = ?,
          resolved_at = ?, resolution_note = ? WHERE notice_id = ?
      `)
      .run(
        command.actorId.value,
        actor.generation.value,
        now.toISOString(),
        command.resolutionNote.value,
        command.noticeId.value,
      );
    const updated: NoticeRow = requireNotice(database, command.noticeId);
    const result: ResolveNoticeResult = {
      alreadyResolved: false,
      notice: mapNoticeRow(updated, now),
    };
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function withdrawSqliteNotice(
  database: Database,
  command: WithdrawNoticeCommand,
  now: Instant,
): WithdrawNoticeResult {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row: NoticeRow = requireNotice(database, command.noticeId);
    if (row.repository_name !== command.repositoryName.value) throw new Error("Unknown notice");
    if (row.creator_id !== command.actorId.value) throw new NoticeOwnershipError();
    if (row.withdrawn_at !== null) {
      const result: WithdrawNoticeResult = {
        alreadyWithdrawn: true,
        notice: mapNoticeRow(row, now),
      };
      database.exec("COMMIT");
      return result;
    }
    if (row.resolved_at !== null || !Instant.parse(row.expires_at).isAfter(now)) {
      throw new NoticeStateConflictError();
    }
    const actor: Agent = renewSqliteSession(
      database,
      command.actorId,
      command.sessionKey,
      now,
      true,
    );
    database
      .query<unknown, [string, number, string, string, string]>(`
        UPDATE notices SET withdrawn_by_id = ?, withdrawn_by_generation = ?,
          withdrawn_at = ?, resolution_note = ? WHERE notice_id = ?
      `)
      .run(
        command.actorId.value,
        actor.generation.value,
        now.toISOString(),
        command.resolutionNote.value,
        command.noticeId.value,
      );
    const updated: NoticeRow = requireNotice(database, command.noticeId);
    const result: WithdrawNoticeResult = {
      alreadyWithdrawn: false,
      notice: mapNoticeRow(updated, now),
    };
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function pruneSqliteNotices(database: Database, now: Instant): number {
  const cutoff: string = now.addDays(-NOTICE_AUDIT_DAYS).toISOString();
  return database
    .query<unknown, [string, string, string]>(`
      DELETE FROM notices
      WHERE (resolved_at IS NOT NULL AND resolved_at <= ?)
        OR (withdrawn_at IS NOT NULL AND withdrawn_at <= ?)
        OR (resolved_at IS NULL AND withdrawn_at IS NULL AND expires_at <= ?)
    `)
    .run(cutoff, cutoff, cutoff).changes;
}
