# Paired inbox reads

`get_messages`, `get_message_history`, and plaintext inbox resource reads use the internal
`MessageStore.getMessagesWithVersion` result. No MCP input, output field, count limit,
pagination behavior, or error contract changes.

Each paired read validates the current agent inside its tenant transaction and resolves the
requested generation once. PostgreSQL first checks for expiry candidates in a separate transaction
and releases that pool lease before any pruning or read transaction. When candidates exist, the
existing separately committed pruning finishes first. SQLite also keeps pruning outside its read transaction.
A supplied named session is
renewed using that same captured instant. Historical reads use their explicit generation for
both the page and version. Unknown agents still fail before payload materialization.

The version is an independent, unfiltered high-water query, not the largest sequence in the
returned page. PostgreSQL preserves its maximum across both plaintext and encrypted inbox rows;
SQLite preserves its plaintext-only maximum because its encrypted sequence space is separate.
Page limits, unread/thread filters and `after_sequence` never restrict the high-water query.
Clients must continue pagination from the last returned message, not `inbox_version`.

PostgreSQL computes the gated payload page and its independent version in one SELECT after
validating the agent. Both use one READ COMMITTED statement snapshot, the same resolved generation,
and the same expiry instant. A commit after that snapshot cannot advance this response's version;
a subsequent read or subscription initialization observes the later durable state. This replaces
the earlier pair of SELECTs, which could return an older page with a later version. No stronger
transaction isolation level, replay, or additional lock is introduced.
The fresh no-candidate expiry check retains its own BEGIN, tenant assignment and COMMIT, so it
releases the connection before the operation rejoins the pool queue. With no named-session renewal,
the complete paired operation uses nine protocol statements, including the separate preflight.

SQLite executes the pair synchronously in a transaction. Lifecycle pruning stays outside it
because that pruning uses an explicit BEGIN. Session renewal has no nested BEGIN, and the existing
page preflight transaction nests through Bun's savepoints.

The [8 MiB payload preflight](inbox-response-budget.md) and its validation remain unchanged.
The reservation covers the combined query and metadata validation. An empty result carries one
strictly validated, payload-free sentinel so it can retain a nonzero independent version without
retaining response bytes. Once materialized, a nonempty page remains charged while transaction
completion and the real handler are unfinished, even if the HTTP response is canceled. It stays
charged until both handler and response finish. Completion failure cannot release an already
settled reservation early. Oversized pages retain their existing actionable error without payload
transfer. Clients still paginate from the last returned message, and subscribe before reading when
they need live hints; a prior read followed by a new MCP subscription does not promise a hint for
an already committed message.

Standalone `getMessages` and `getInboxVersion` remain available. Long polling does not request an
unused version, and subscription/reconnect checks retain their independent authoritative read.
