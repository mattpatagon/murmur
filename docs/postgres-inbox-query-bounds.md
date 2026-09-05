# PostgreSQL inbox query bounds

Plaintext `getMessages` and `markMessagesRead` validate the reader inside the same tenant-scoped
transaction that reads or acknowledges messages. They do not run a separate `getAgent` precheck.
The operation still reads the clock once and completes expiration pruning first. Inbox version
lookups and subscription validation are unchanged.

With no expiration candidates and no named session renewal, an inbox read or nonempty
acknowledgement uses two transactions and nine PostgreSQL protocol statements: four for the
payload-free prune preflight and five for the inbox operation. An empty acknowledgement uses
eight statements, including the current reader lookup. Removing the duplicate precheck saves one
transaction and five statements per call; it does not cache agent existence or remove validation.

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
