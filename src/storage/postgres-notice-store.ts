import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";

import {
  IdempotencyConflictError,
  NoticeOwnershipError,
  NoticeStateConflictError,
} from "../domain/errors.js";
import { NOTICE_AUDIT_DAYS, NoticeId, SessionKey } from "../domain/lifecycle-values.js";
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
import { Instant, type TenantId } from "../domain/value-objects.js";
import { mapNoticeRow, type NoticeRow, NoticeRowSchema } from "./notice-rows.js";
import { renewPostgresSessionInTransaction } from "./postgres-agent-lifecycle-store.js";
import {
  lockPostgresRecipientCommitOrder,
  setPostgresTenantContext,
} from "./postgres-message-transactions.js";
import { readPostgresNoticePage } from "./postgres-notice-page.js";

async function noticeRow(
  transaction: TransactionSql,
  tenantId: TenantId,
  noticeId: NoticeId,
  forUpdate: boolean,
): Promise<NoticeRow | null> {
  const raw: unknown = forUpdate
    ? await transaction`
        SELECT notice_id::text AS notice_id, kind, creator_id, creator_generation,
          repository_name, branch_name, content, idempotency_key,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          resolved_by_id, resolved_by_generation,
          CASE WHEN resolved_at IS NULL THEN NULL ELSE
            to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS resolved_at,
          withdrawn_by_id, withdrawn_by_generation,
          CASE WHEN withdrawn_at IS NULL THEN NULL ELSE
            to_char(withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS withdrawn_at,
          resolution_note
        FROM murmur.notices
        WHERE tenant_id = ${tenantId.value}::uuid AND notice_id = ${noticeId.value}::uuid
        FOR UPDATE
      `
    : await transaction`
        SELECT notice_id::text AS notice_id, kind, creator_id, creator_generation,
          repository_name, branch_name, content, idempotency_key,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          resolved_by_id, resolved_by_generation,
          CASE WHEN resolved_at IS NULL THEN NULL ELSE
            to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS resolved_at,
          withdrawn_by_id, withdrawn_by_generation,
          CASE WHEN withdrawn_at IS NULL THEN NULL ELSE
            to_char(withdrawn_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS withdrawn_at,
          resolution_note
        FROM murmur.notices
        WHERE tenant_id = ${tenantId.value}::uuid AND notice_id = ${noticeId.value}::uuid
      `;
  const rows: NoticeRow[] = z.array(NoticeRowSchema).parse(raw);
  return rows[0] ?? null;
}

function samePost(row: NoticeRow, command: PostNoticeCommand): boolean {
  const storedTtl: number =
    Instant.parse(row.expires_at).toEpochMilliseconds() -
    Instant.parse(row.created_at).toEpochMilliseconds();
  const requestedTtl: number = command.expiresInHours * 60 * 60 * 1000;
  return (
    row.kind === command.kind &&
    row.content === command.content.value &&
    row.repository_name === command.repositoryName.value &&
    row.branch_name === (command.branchName === null ? null : command.branchName.value) &&
    storedTtl === requestedTtl
  );
}

async function existingPost(
  transaction: TransactionSql,
  tenantId: TenantId,
  command: PostNoticeCommand,
  now: Instant,
): Promise<PostNoticeResult | null> {
  if (command.idempotencyKey === null) return null;
  const rawId: unknown = await transaction`
    SELECT notice_id::text AS notice_id FROM murmur.notices
    WHERE tenant_id = ${tenantId.value}::uuid
      AND creator_id = ${command.actorId.value}
      AND idempotency_key = ${command.idempotencyKey.value}
  `;
  const ids: { readonly notice_id: string }[] = z
    .array(z.strictObject({ notice_id: z.string() }))
    .parse(rawId);
  const idRow: { readonly notice_id: string } | undefined = ids[0];
  if (idRow === undefined) return null;
  const id: string = idRow.notice_id;
  const row: NoticeRow | null = await noticeRow(transaction, tenantId, NoticeId.parse(id), false);
  if (row === null) throw new Error("Idempotent notice disappeared");
  if (!samePost(row, command)) throw new IdempotencyConflictError(command.idempotencyKey.value);
  return { duplicate: true, notice: mapNoticeRow(row, now) };
}

export async function postPostgresNotice(
  database: Sql,
  tenantId: TenantId,
  command: PostNoticeCommand,
  now: Instant,
): Promise<PostNoticeResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<PostNoticeResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
      command.actorId.value,
    ]);
    const prior: PostNoticeResult | null = await existingPost(transaction, tenantId, command, now);
    if (prior !== null) return prior;
    const actor: Agent = await renewPostgresSessionInTransaction(
      transaction,
      tenantId,
      command.actorId,
      command.sessionKey,
      now,
      true,
    );
    const noticeId: NoticeId = NoticeId.generate();
    await transaction`
      INSERT INTO murmur.notices(
        tenant_id, notice_id, kind, creator_id, creator_generation,
        repository_name, branch_name, content, idempotency_key, created_at, expires_at
      ) VALUES (
        ${tenantId.value}::uuid, ${noticeId.value}::uuid, ${command.kind},
        ${command.actorId.value}, ${actor.generation.value}, ${command.repositoryName.value},
        ${command.branchName === null ? null : command.branchName.value}, ${command.content.value},
        ${command.idempotencyKey === null ? null : command.idempotencyKey.value},
        ${now.toISOString()}::timestamptz,
        ${now.addHours(command.expiresInHours).toISOString()}::timestamptz
      )
    `;
    const row: NoticeRow | null = await noticeRow(transaction, tenantId, noticeId, false);
    if (row === null) throw new Error("Inserted notice could not be read back");
    return { duplicate: false, notice: mapNoticeRow(row, now) };
  });
}

export async function listPostgresNotices(
  database: Sql,
  tenantId: TenantId,
  query: ListNoticesQuery,
  now: Instant,
): Promise<ListNoticesResult> {
  return await database.begin(async (transaction: TransactionSql): Promise<ListNoticesResult> => {
    await setPostgresTenantContext(transaction, tenantId);
    if (query.sessionKey !== null) {
      await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        query.actorId,
        query.sessionKey,
        now,
        false,
      );
    } else {
      await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        query.actorId,
        SessionKey.default(),
        now,
        false,
      );
    }
    return await readPostgresNoticePage(transaction, tenantId, query, now);
  });
}

async function changeNotice(
  database: Sql,
  tenantId: TenantId,
  command: ResolveNoticeCommand | WithdrawNoticeCommand,
  now: Instant,
  action: "resolve" | "withdraw",
): Promise<{ readonly alreadyChanged: boolean; readonly notice: Notice }> {
  return await database.begin(
    async (
      transaction: TransactionSql,
    ): Promise<{ readonly alreadyChanged: boolean; readonly notice: Notice }> => {
      await setPostgresTenantContext(transaction, tenantId);
      await lockPostgresRecipientCommitOrder(database, transaction, tenantId, [
        command.actorId.value,
      ]);
      const row: NoticeRow | null = await noticeRow(transaction, tenantId, command.noticeId, true);
      if (row === null || row.repository_name !== command.repositoryName.value) {
        throw new Error("Unknown notice");
      }
      if (action === "resolve" && row.resolved_at !== null) {
        return { alreadyChanged: true, notice: mapNoticeRow(row, now) };
      }
      if (action === "withdraw" && row.creator_id !== command.actorId.value) {
        throw new NoticeOwnershipError();
      }
      if (action === "withdraw" && row.withdrawn_at !== null) {
        return { alreadyChanged: true, notice: mapNoticeRow(row, now) };
      }
      if (
        row.resolved_at !== null ||
        row.withdrawn_at !== null ||
        !Instant.parse(row.expires_at).isAfter(now)
      ) {
        throw new NoticeStateConflictError();
      }
      const actor: Agent = await renewPostgresSessionInTransaction(
        transaction,
        tenantId,
        command.actorId,
        command.sessionKey,
        now,
        true,
      );
      if (action === "resolve") {
        await transaction`
        UPDATE murmur.notices SET resolved_by_id = ${command.actorId.value},
          resolved_by_generation = ${actor.generation.value},
          resolved_at = ${now.toISOString()}::timestamptz,
          resolution_note = ${command.resolutionNote.value}
        WHERE tenant_id = ${tenantId.value}::uuid AND notice_id = ${command.noticeId.value}::uuid
      `;
      } else {
        await transaction`
        UPDATE murmur.notices SET withdrawn_by_id = ${command.actorId.value},
          withdrawn_by_generation = ${actor.generation.value},
          withdrawn_at = ${now.toISOString()}::timestamptz,
          resolution_note = ${command.resolutionNote.value}
        WHERE tenant_id = ${tenantId.value}::uuid AND notice_id = ${command.noticeId.value}::uuid
      `;
      }
      const updated: NoticeRow | null = await noticeRow(
        transaction,
        tenantId,
        command.noticeId,
        false,
      );
      if (updated === null) throw new Error("Updated notice could not be read back");
      return { alreadyChanged: false, notice: mapNoticeRow(updated, now) };
    },
  );
}

export async function resolvePostgresNotice(
  database: Sql,
  tenantId: TenantId,
  command: ResolveNoticeCommand,
  now: Instant,
): Promise<ResolveNoticeResult> {
  const result: { readonly alreadyChanged: boolean; readonly notice: Notice } = await changeNotice(
    database,
    tenantId,
    command,
    now,
    "resolve",
  );
  return { alreadyResolved: result.alreadyChanged, notice: result.notice };
}

export async function withdrawPostgresNotice(
  database: Sql,
  tenantId: TenantId,
  command: WithdrawNoticeCommand,
  now: Instant,
): Promise<WithdrawNoticeResult> {
  const result: { readonly alreadyChanged: boolean; readonly notice: Notice } = await changeNotice(
    database,
    tenantId,
    command,
    now,
    "withdraw",
  );
  return { alreadyWithdrawn: result.alreadyChanged, notice: result.notice };
}

export async function prunePostgresNotices(
  transaction: TransactionSql,
  tenantId: TenantId,
  now: Instant,
): Promise<number> {
  const cutoff: string = now.addDays(-NOTICE_AUDIT_DAYS).toISOString();
  const raw: unknown = await transaction`
    WITH expired AS (
      SELECT tenant_id, notice_id FROM murmur.notices
      WHERE tenant_id = ${tenantId.value}::uuid AND (
        (resolved_at IS NOT NULL AND resolved_at <= ${cutoff}::timestamptz)
        OR (withdrawn_at IS NOT NULL AND withdrawn_at <= ${cutoff}::timestamptz)
        OR (resolved_at IS NULL AND withdrawn_at IS NULL
            AND expires_at <= ${cutoff}::timestamptz)
      ) ORDER BY expires_at, notice_id LIMIT 1000
    ), deleted AS (
      DELETE FROM murmur.notices AS notice USING expired
      WHERE notice.tenant_id = expired.tenant_id AND notice.notice_id = expired.notice_id
      RETURNING 1
    ) SELECT COUNT(*)::int AS count FROM deleted
  `;
  const rows: { readonly count: number }[] = z
    .array(z.strictObject({ count: z.number().int().nonnegative() }))
    .parse(raw);
  const row: { readonly count: number } | undefined = rows[0];
  return row === undefined ? 0 : row.count;
}
