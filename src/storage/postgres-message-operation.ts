import type { Sql, TransactionSql } from "postgres";

import type { Instant, TenantId } from "../domain/value-objects.js";
import { postgresHasPruneCandidates } from "./postgres-expiry-preflight.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";
import { normalizePostgresStorageError } from "./postgres-storage-errors.js";

type PostgresTenantOperation<Result> = (transaction: TransactionSql) => Promise<Result>;

export type PostgresTenantTransactionRunner = <Result>(
  operation: PostgresTenantOperation<Result>,
) => Promise<Result>;

export function createPostgresTenantTransactionRunner(
  database: Sql,
  tenantId: TenantId,
): PostgresTenantTransactionRunner {
  return async <Result>(operation: PostgresTenantOperation<Result>): Promise<Result> => {
    // Boxing preserves arbitrary result types through postgres.js's array-unwrapping signature.
    const result: { readonly value: Result } = await database.begin(
      async (transaction: TransactionSql): Promise<{ readonly value: Result }> => {
        await setPostgresTenantContext(transaction, tenantId);
        return { value: await operation(transaction) };
      },
    );
    return result.value;
  };
}

export function createPruneAwarePostgresTransactionRunner(
  database: Sql,
  tenantId: TenantId,
  now: Instant,
  pruneCandidates: () => Promise<number>,
): PostgresTenantTransactionRunner {
  return async <Result>(operation: PostgresTenantOperation<Result>): Promise<Result> => {
    let hasCandidates: boolean;
    try {
      hasCandidates = await postgresHasPruneCandidates(database, tenantId, now);
    } catch (error: unknown) {
      throw normalizePostgresStorageError(error);
    }
    // Release even an empty preflight's pool lease before joining the operation queue again.
    // Candidates may remain after bounded pruning; execute once instead of retrying them.
    if (hasCandidates) await pruneCandidates();
    return await createPostgresTenantTransactionRunner(database, tenantId)(operation);
  };
}
