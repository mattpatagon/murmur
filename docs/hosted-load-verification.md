# Reproducible hosted load verification

`bun scripts/verify-hosted-load.ts` exercises real hosted HTTP against a dedicated local PostgreSQL
database. Its default population is 25,000 tenants, each with a synthetic agent credential. It
measures a bounded concurrent workload across those accounts; it does not claim 25,000 simultaneous
connections or reproduce Cloud Run, Supabase network latency, or their billing behavior.

## Disposable database prerequisites

Reserve this host's database/load resources through Murmur before running. Use Bun 1.3.14 and an
otherwise idle PostgreSQL 17 instance. Provision a disposable database named
`murmur_load_<suffix>`, apply every committed migration, provision `murmur_app`, and complete the
strict operator/bootstrap and tenant-contract-v2 setup using the existing hosted verification
workflow. A dedicated copy of its completed disposable database is suitable. Do not copy production
data. The load runner does not migrate, bootstrap, provision roles, or change existing credentials.

Provide only these task-specific credentials through the environment, without writing them to
logs, command arguments, shell history, or the repository:

```dotenv
MURMUR_LOAD_DISPOSABLE=1
MURMUR_LOAD_ADMIN_DATABASE_URL=postgresql://<admin>:<password>@127.0.0.1:5432/murmur_load_launch?sslmode=disable
MURMUR_LOAD_RUNTIME_DATABASE_URL=postgresql://murmur_app:<password>@127.0.0.1:5432/murmur_load_launch?sslmode=disable
```

The runner accepts only literal `127.0.0.1` or `[::1]`, the dedicated database-name prefix, matching
host/port/database in both URLs, and the `murmur_app` runtime username. It rejects remote addresses,
generic databases, additional connection options, and missing disposable opt-in before connection.
An advisory lock prevents a competing copy from using the same database. The preflight verifies the
connected database, non-superuser/non-BYPASSRLS/non-owner runtime, forced tenant RLS, an active
operator, and tenant contract version 2.

Admin SQL only seeds synthetic tenants/tokens in batches of 500, collects aggregate measurements,
and removes the runner's fixture. Each token gets its own explicit `personal_id`. HTTP traffic uses
the runtime database credential in a separate child process; the child receives no admin credential.

## Workload and assertions

The ramp offers 1, 4, 16, and 64 simultaneous journeys against four authentication slots. Every
journey initializes an MCP session, registers two agents, reads an empty unread inbox, sends one
message, repeats its idempotency key, verifies the exact delivery, acknowledges it, verifies the
empty unread inbox, and disconnects. Agent IDs and per-phase idempotency keys are deliberately
identical across tenants; message identity and content differ, making cross-tenant leakage or
global idempotency collisions a failure. A foreign-session probe must return the precise 404
session-miss contract. Direct runtime SQL checks verify tenant context and its transaction cleanup.

Concurrent attacks use malformed credentials, forged material with a valid victim key ID, and
random well-formed unknown credentials. The attacks overlap known-credential traffic and a separate
set of previously unused credentials. Every attack response must deny access without issuing a
session. Accepted attack statuses are 401 or bounded authentication overload 503. Attack metrics
are separate from legitimate-request latency metrics.

The full account sweep must successfully exercise every seeded tenant. A final phase fills the
configured session ceiling and all 64 stream slots, requires the corresponding 503 gate messages,
releases them, and proves both messaging and standalone-stream recovery. It does not raise the
application’s authentication, request, stream, tenant, or rate limits to make the workload pass.

The [PostgreSQL inbox query contract](postgres-inbox-query-bounds.md) records fixed per-operation
query reductions and their isolation regressions. These reductions do not replace this load gate.

## Bounds and output

| Variable | Default | Accepted range |
| --- | --- | --- |
| `MURMUR_LOAD_TENANTS` | 25000 | 128–25000 |
| `MURMUR_LOAD_CONCURRENCY` | 8 | 1–64 |
| `MURMUR_LOAD_SESSIONS` | 1000 | 64–1000 |
| `MURMUR_LOAD_DURATION_SECONDS` | 3600 | 120–7200 |
| `MURMUR_LOAD_P95_MS` | 2000 | 50–5000 |
| `MURMUR_LOAD_P99_MS` | 5000 | 100–10000 |
| `MURMUR_LOAD_RSS_MIB` | 512 | 128–512 |

Smaller populations/session ceilings are development profiles and are recorded explicitly; only a
successful default-population run is evidence for the 25,000-account workload. Thresholds are
per-request-operation percentiles including retry/backoff time. Legitimate 429/503 responses get
at most eight attempts within a 15-second deadline, honoring bounded numeric `Retry-After` values.
HTTP 200 JSON or SSE responses also retry only the exact processing/materialization JSON-RPC
capacity error: matching request ID, code `-32003`, the fixed capacity message, and precisely
`{"retryable":true,"retry_after_ms":1000}`. Other tool, schema, authentication, or malformed errors
are not retried. Capacity waits start at one second; all waits, including jitter, share the same
15-second deadline and stop on cancellation. No retry hides its status code or latency: each
capacity response remains an actual HTTP 200 attempt and increments `mcpCapacityResponses` in
the phase report, even when retries are disabled or exhausted. Each attempt has a 10-second maximum;
the overall workload deadline aborts active HTTP. Database statements and lock acquisition also have deadlines.
Cleanup starts no new batch after 60 seconds; a hard process backstop at the configured workload
duration plus 120 seconds exits nonzero if shutdown cannot finish. Cleanup failures retain that
backstop so a lingering child, IPC channel, or database handle cannot keep the runner alive forever.
The timer is unreferenced: it does not delay ordinary failure exit after all other handles close.
Successful cleanup clears it, even when the workload itself failed.

The child reports its own RSS every 250 ms. Crossing the configured limit kills it and fails the
run. This samples process RSS; it is not a kernel cgroup limit and excludes PostgreSQL and the load
generator. The default 512 MiB budget matches the committed Cloud Run memory setting. Local CPU,
database, and storage contention can affect results, so retain host context with the report.

Output is newline-delimited JSON: a heartbeat every 30 seconds and a final aggregate report with
phase duration, attempted throughput, retry/status counts, p50/p95/p99 operation latency, child RSS,
logical fixture row counts, and whole-database/Murmur-schema bytes before seeding and after traffic.
It prints no credentials, message bodies, raw session IDs, URLs, or exception text. Any semantic,
latency, RSS, completeness, or cleanup failure exits nonzero. Retain the full report, not just the
exit status. A failed run is evidence of an unmet gate, not a passing capacity claim.

Attempt status `0` means no HTTP response was received. If reading or parsing a received response
fails, its actual status remains counted and the operation still fails without retry. The fixed
failure diagnostic identifies `fetch`, `body-read` or `body-parse`, the observed status, and only an
allowlisted error name/code (`ConnectionClosed`, `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `ABORT_ERR`,
`AbortError`, `TimeoutError`, `TypeError`, `SyntaxError`); all other labels become `unclassified`.
Raw exception messages, stacks and response content are never included.

Child cleanup succeeds only after an observed exit code zero following the stop request; earlier
exits, signals, IPC errors, and forced termination fail the run. Concurrent or repeated close calls
share the same success or failure. IPC acknowledgement has a one-second deadline within the existing
six-second graceful-exit budget. Forced termination waits up to two additional seconds for an
observed exit; an unconfirmed exit remains a cleanup failure rather than successful shutdown.
Fixture cleanup is still attempted after any child shutdown failure.

The runner deletes only its generated tenant IDs and dependent
fixture rows, then verifies they are gone. PostgreSQL may retain allocated files after deletion;
drop the explicitly provisioned disposable database afterward through the provisioning workflow.
An externally killed runner may leave fixture rows in that disposable database. Database bytes
include indexes and prior fixture state, and do not estimate paid hosting or database charges.
