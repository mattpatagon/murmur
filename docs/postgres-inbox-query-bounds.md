# PostgreSQL inbox query bounds

Plaintext `getMessages` and `markMessagesRead` validate the reader inside the same tenant-scoped
transaction that reads or acknowledges messages. They do not run a separate `getAgent` precheck.
The operation reads the clock once and checks expiration before reading agent or message data.
Standalone inbox version lookups and subscription validation are unchanged.

With no expiration candidates and no named session renewal, an inbox read or nonempty
acknowledgement uses two transactions and nine PostgreSQL protocol statements. An empty
acknowledgement uses eight, including the current reader lookup. The fresh payload-free expiry
check releases its pool lease before the operation acquires a new tenant-scoped transaction.
It does not cache expiration or agent existence, or remove validation.

MCP page-and-version reads use the [paired inbox transaction](inbox-read-transactions.md), which
computes the gated page and independent version in one statement snapshot. With the same preconditions,
history and resource pairs use nine protocol statements; a current `get_messages` page uses ten
when it adds an automatic acknowledgement statement and nine when every returned row already has a
receipt. Direct sends also release their fresh expiry preflight's pool lease before the operation
transaction. When candidates exist, the preflight commits before the original bounded message and
lifecycle cleanup transactions run. The operation then runs exactly once in a new tenant
transaction. Cleanup remains committed if the operation later fails, and retained candidates do
not cause a retry loop. See [expiry preflights](postgres-expiry-preflight.md).

Unknown readers still fail, including empty acknowledgements. Current generation, historical
generation filters, tenant qualification, default-session behavior and existing named-session
renewal remain enforced by the inbox transaction. Observer reads never create missing sessions.

The hot-path agent lifecycle, sender/recipient validation and hosted authentication adapters reuse
static Zod row schemas. Every returned row is still parsed with the same constraints, including
the authentication result's maximum of one principal. These schemas capture no tenant, request,
credential or database result.

`test/postgres-inbox-query-count.test.ts` checks transaction boundaries, absence of the outer
lookup, clock/prune ordering, unknown and malformed readers, and schema reuse with malformed-row
rejection. `test/postgres-inbox-transactions.test.ts` exercises the least-privilege runtime role
against disposable PostgreSQL, counts actual protocol statements, and covers tenant isolation,
generation rollover/history, inbox version, acknowledgements and session renewal. Its generated
actor identities also work before tenant-contract finalization; cleanup targets only its two
fixture tenants. `test/postgres-prune-operation-transactions.test.ts` checks candidate transitions,
commit and failure ordering, safe preflight errors, no operation replay, and ordinary standalone
adapter transactions. A no-candidate preflight commit failure prevents operation entry as well.
The unchanged full hosted load remains the performance acceptance gate.
`test/postgres-inbox-snapshot.test.ts` rejects malformed combined metadata and empty sentinels,
and checks reservation ownership during cancellation. The real PostgreSQL snapshot concurrency
test commits another message after the page statement and verifies that the returned version stays
with that page, while cursor continuation and subscription initialization recover the later message.
`test/postgres-send-transactions.test.ts` records real runtime-role protocol statements for a
named-session send and duplicate retry, preserving the original message and lease on duplicates.
It also verifies that expired rows and their charged bytes stay reclaimed after idempotency,
provenance or closed-recipient failures, while an attempted sender renewal rolls back.

## Registration activity accounting

Registration writes `last_seen_at` in its agent INSERT or UPDATE, under the existing tenant/agent
transaction lock. Its subsequent session renewal does not write the same timestamp again. Every
other renewal caller keeps the existing activity update; sending still advances sender activity.
Existing-agent session renewal, trimming, authority validation and generation handling are
unchanged. [Activation notifications](registration-activation.md) also use the registration
transaction's existing state. No timestamp or agent-existence result is cached.

A fresh registration uses nine protocol statements rather than fourteen. After the locked absence
check and agent INSERT, the immediate tenant-qualified foreign key proves that the uncommitted new
parent has no prior session history. The adapter validates the exact single INSERT-returned
generation, upserts its first session, and still reads and validates the actual final agent row.
It omits only the second expiry update, stored-agent reread, session-existence and live-count queries,
and retained-session trim. Existing-agent paths and both writes' quota/storage triggers remain.
Missing, duplicate or malformed generation rows stop before session writes; an invalid final agent
row rolls back both writes. No returned metadata or state is synthesized from request input.

`test/postgres-registration-accounting.test.ts` calls the existing adapter API as `murmur_app`,
with function-statistics collection enabled by the disposable test owner. It measures before/after
table and function counters inside each actual operation's transaction, without timing sleeps or
statistics resets. A fresh registration changes from one INSERT plus one agent UPDATE to only the
INSERT. Re-registering an existing agent changes from two agent UPDATEs to one. Each removes one
accounting-trigger invocation and two old/new row-cost calculations; those accounting calculations
previously ran even though the byte delta was zero. The tests retain default/named session,
repository divergence, authority, reopening/generation and send-activity contracts, then clean up
only their generated tenants. This is a measured query/tuple reduction, not a full-load latency or
throughput guarantee, and it makes no assumption about PostgreSQL HOT or index writes.
