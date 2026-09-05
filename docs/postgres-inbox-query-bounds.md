# PostgreSQL inbox query bounds

Plaintext `getMessages` and `markMessagesRead` validate the reader inside the same tenant-scoped
transaction that reads or acknowledges messages. They do not run a separate `getAgent` precheck.
The operation still reads the clock once and completes expiration pruning first. Standalone
inbox version lookups and subscription validation are unchanged.

With no expiration candidates and no named session renewal, an inbox read or nonempty
acknowledgement uses two transactions and nine PostgreSQL protocol statements: four for the
payload-free prune preflight and five for the inbox operation. An empty acknowledgement uses
eight statements, including the current reader lookup. Removing the duplicate precheck saves one
transaction and five statements per call; it does not cache agent existence or remove validation.

MCP page-and-version reads use the [paired inbox transaction](inbox-read-transactions.md), which
adds the independent version query to the existing inbox transaction. With the same preconditions,
the pair uses ten protocol statements instead of fourteen across separate reads.

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
fixture tenants. The unchanged full hosted load remains the performance acceptance gate.

## Registration activity accounting

Registration writes `last_seen_at` in its agent INSERT or UPDATE, under the existing tenant/agent
transaction lock. Its subsequent session renewal does not write the same timestamp again. Every
other renewal caller keeps the existing activity update; sending still advances sender activity.
Session creation, renewal, trimming, agent lookup, authority validation and generation handling
are unchanged. [Activation notifications](registration-activation.md) also use the registration
transaction's existing state. No timestamp or agent-existence result is cached.

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
