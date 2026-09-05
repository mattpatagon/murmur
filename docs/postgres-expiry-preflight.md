# PostgreSQL no-expiry fast path

Every plaintext prune first makes one tenant-scoped, read-only candidate query in a
transaction with the runtime role and transaction-local tenant context. When no candidate
exists at the supplied clock, cleanup returns zero without issuing the existing write queries.
Encrypted pruning performs its candidate query inside its existing tenant transaction.

Plaintext direct sends, inbox reads, paired page/version reads and acknowledgements share this
fresh check with their operation transaction when no candidate exists. Tenant context is assigned
once, before the check and all agent or payload work. A positive check commits and releases its
connection before running the original separately committed pruning, then starts one ordinary
tenant transaction for the operation. Pruning is never nested under the initial transaction and
is not rolled back by a later operation failure. Remaining bounded or referenced candidates do
not trigger a loop. Standalone `pruneExpired` retains its independent preflight transaction.

The check is not a TTL, cache, background timer, or deferred cleanup policy. Each invocation
uses a fresh database snapshot and the caller's exact timestamp. Equality at an expiration
boundary is a candidate. A positive result runs the original physical cleanup, including
batch sizes, usage accounting, advisory locks, lifecycle rechecks, and reference guards.
An invalid database response fails closed instead of silently skipping cleanup.

Plaintext candidates cover expired messages and broadcasts, the notice audit retention
cutoff, expired live leases, retained ended leases, dormant open agents, and closed-agent
garbage collection. The lifecycle checks intentionally overapproximate: a referenced agent,
live lease, or orchestrator can cause a harmless extra cleanup pass, but cannot bypass the
existing protection against closing or deleting that agent.

Encrypted candidates cover expired ciphertext, expired direct claims including consumed
claims, expired broadcasts of every state, expired public prekeys, and retired or claimed
prekeys with no referencing claim. A missing usage row also forces the original cleanup
path, preserving its validation error. The usage-update helper is unchanged; no independent
zero-delta shortcut was added.

This reduces the common empty plaintext cleanup from two transactions and eleven SQL
statements (including tenant context) to one transaction and two statements. Including
BEGIN and COMMIT, that is fifteen versus four protocol query executions for standalone cleanup.
The combined no-candidate operation saves another BEGIN, tenant assignment and COMMIT compared
with separate preflight and operation transactions. Expired data
adds one read-only preflight transaction to the existing cleanup cost. The encrypted
empty path retains one transaction but avoids usage-row locks and no-op writes.

This does not serialize cleanup against concurrent insertion. A row committed after the
probe snapshot is picked up by a later operation, just as a row committed after an existing
DELETE snapshot was previously. Reads and acknowledgments retain their expiration and
tenant predicates. No negative result survives the current invocation.

Verification uses deterministic query recordings for the one-query probe and strict row
validation, plus disposable PostgreSQL tests for exact expiration boundaries, plaintext
idempotency and physical usage reclamation, lifecycle and notice candidates, encrypted
cleanup-only candidates, missing usage state, and tenant isolation. The load runner's
latency, retry, and memory thresholds must not change as part of this optimization.
