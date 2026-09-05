import type { Sql, TransactionSql } from "postgres";

import type { Instant, TenantId } from "../domain/value-objects.js";
import { queryPostgresPruneCandidates } from "./postgres-expiry-preflight.js";
import { setPostgresTenantContext } from "./postgres-message-transactions.js";
import { normalizePostgresStorageError } from "./postgres-storage-errors.js";

type PostgresTenantOperation<Result> = (transaction: TransactionSql) => Promise<Result>;

export type PostgresTenantTransactionRunner = <Result>(
  operation: PostgresTenantOperation<Result>,
) => Promise<Result>;

type OperationAttempt<Result> =
  | { readonly kind: "needs-prune" }
  | { readonly kind: "completed"; readonly value: Result };

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
    let operationStarted: boolean = false;
    let attempt: OperationAttempt<Result>;
    try {
      attempt = await database.begin(
        async (transaction: TransactionSql): Promise<OperationAttempt<Result>> => {
          await setPostgresTenantContext(transaction, tenantId);
          if (await queryPostgresPruneCandidates(transaction, tenantId, now)) {
            return { kind: "needs-prune" };
          }
          operationStarted = true;
          return { kind: "completed", value: await operation(transaction) };
        },
      );
    } catch (error: unknown) {
      // The old prune preflight normalized failures; operation and operation-commit errors did not.
      throw operationStarted ? error : normalizePostgresStorageError(error);
    }
    if (attempt.kind === "completed") return attempt.value;
    // Release the preflight transaction before the independently committed, bounded pruning phases.
    // Candidates may remain after pruning; execute once instead of retrying until they disappear.
    await pruneCandidates();
    return await createPostgresTenantTransactionRunner(database, tenantId)(operation);
  };
}
