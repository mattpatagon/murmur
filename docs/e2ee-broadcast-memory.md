# Encrypted broadcast finalization memory

Encrypted broadcast commit reads at most four full staged deliveries at once. Each delivery has an
envelope and a sender-chain JSON field bounded to 1 MiB each, giving an 8 MiB serialized payload
ceiling per batch. This bounds retained payload references, not exact process RSS: database-driver
buffers, JavaScript strings, parsing, validation, serialization and garbage collection add overhead.

Commit first reads only recipient identity/generation, claim identity, acceptance time, ciphertext
count and JSON byte lengths. The query returns at most 101 small metadata rows; anything beyond the
100-recipient limit, an incomplete row or a count different from the frozen broadcast fails before
full payloads are fetched. PostgreSQL retains the existing broadcast and delivery row locks, sorted
recipient advisory locks and current-generation checks. SQLite uses its existing `BEGIN IMMEDIATE`
transaction. Payload batches must exactly match the snapshot's membership, order and metadata.

Hosted commit reserves temporary capacity from the shared materialization budget after generation
validation and before sequence allocation or the first payload read. The reservation equals the
largest planned batch's serialized JSON bytes, never more than 8 MiB. It is nonwaiting: failure
rolls back the transaction. One reservation covers the entire batch loop and is released in
`finally` after the actual validation/insertion work settles. The small commit acknowledgement does
not retain this scratch reservation through HTTP response delivery. Local callers outside a hosted
materialization scope retain the same batch limits without inheriting hosted admission policy.

All batches execute within one transaction. Sequence allocation still happens once, message order
still follows the original recipient snapshot, and usage is updated only after all deliveries are
inserted. Failure in a later batch or final usage accounting rolls back earlier inserts, sequence
allocation, broadcast state and retained-storage accounting. Notifications become visible only on
commit. An exact committed retry returns its original result before rechecking current generations.

SQLite now performs the same commit-time recipient-generation, sender-chain structure and
envelope/snapshot/ciphertext-length checks as PostgreSQL. Its SQL metadata preflight measures UTF-8
bytes using `length(CAST(value AS BLOB))` before loading JSON into JavaScript. Previously staged
SQLite envelope or sender-chain fields larger than 1 MiB are rejected during commit, aligning with
the existing hosted PostgreSQL field bounds. No staged data is truncated, rewritten or deleted, and
no upload protocol or migration changes. Existing cancellation and retention rules still apply.

## Verification

The bounded local checks are:

```sh
bun test test/e2ee-broadcast-commit-batches.test.ts \
  test/e2ee-broadcast-finalize-bounds.test.ts test/e2ee-sqlite-store.test.ts
```

With both disposable hosted database URLs and the usual test TLS settings configured, run serially:

```sh
bun test test/e2ee-postgres-broadcast-finalize-bounds.test.ts
```

The PostgreSQL suite includes 100 maximum-size ciphertext envelopes, checks 25 payload fetches,
exact sequence and usage totals, tenant isolation, idempotent retry, late validation rollback and
late accounting rollback/recovery. It prints commit duration and RSS observations without payloads
or identifiers. The fixture itself seeds one large envelope at a time. These are staged-storage
tests; existing E2EE store tests separately exercise cryptographic upload verification.

Four-row batches add up to 25 payload-fetch round trips compared with the former all-at-once read.
The existing 10-second PostgreSQL statement timeout is per statement, not an end-to-end commit or
JavaScript parsing deadline. The full 100-recipient real PostgreSQL measurement remains a required
deployment verification: batching alone establishes neither a latency guarantee nor peak RSS.

On 2026-09-05, the coordinated disposable PostgreSQL run passed all three integration tests
(28 assertions). Its 100-recipient maximum-envelope commit took 6,905 ms, fetched 25 payload
batches and reserved at most 2,804,268 serialized scratch bytes for those particular envelopes and
small signing chains. Process RSS sampled before and after was 106,885,120 and 159,985,664 bytes.
These observations do not measure peak RSS, prove a cgroup memory ceiling or establish concurrent
production latency; the 8 MiB worst-case batch allowance still applies.
