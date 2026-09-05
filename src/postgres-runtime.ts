import type { ConnectionParameters } from "postgres";

export const POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS: number = 10_000;
export const POSTGRES_RUNTIME_LOCK_TIMEOUT_MS: number = 2_000;
export const POSTGRES_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS: number = 15_000;

type RuntimeConnectionParameters = Readonly<
  Pick<
    ConnectionParameters,
    "idle_in_transaction_session_timeout" | "lock_timeout" | "statement_timeout"
  >
>;

export const POSTGRES_RUNTIME_CONNECTION: RuntimeConnectionParameters = Object.freeze({
  idle_in_transaction_session_timeout: POSTGRES_RUNTIME_IDLE_TRANSACTION_TIMEOUT_MS,
  lock_timeout: POSTGRES_RUNTIME_LOCK_TIMEOUT_MS,
  statement_timeout: POSTGRES_RUNTIME_STATEMENT_TIMEOUT_MS,
});

export const POSTGRES_RUNTIME_POOL: Readonly<{
  connect_timeout: number;
  connection: RuntimeConnectionParameters;
  max: number;
}> = Object.freeze({
  connect_timeout: 10,
  connection: POSTGRES_RUNTIME_CONNECTION,
  max: 4,
});
