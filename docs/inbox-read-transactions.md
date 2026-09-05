# Paired inbox reads

`get_messages`, `get_message_history`, and plaintext inbox resource reads use the internal
`MessageStore.getMessagesWithVersion` result. No MCP input, output field, count limit,
pagination behavior, or error contract changes.

Each paired read validates the current agent inside its tenant transaction and resolves the
requested generation once. PostgreSQL first checks for expiry candidates in that transaction;
when candidates exist, it commits the check and completes the existing separate pruning before
opening the read transaction. SQLite keeps pruning outside its read transaction.
A supplied named session is
renewed using that same captured instant. Historical reads use their explicit generation for
both the page and version. Unknown agents still fail before payload materialization.

The version is an independent, unfiltered high-water query, not the largest sequence in the
returned page. PostgreSQL preserves its maximum across both plaintext and encrypted inbox rows;
SQLite preserves its plaintext-only maximum because its encrypted sequence space is separate.
Page limits, unread/thread filters and `after_sequence` never restrict the high-water query.
Clients must continue pagination from the last returned message, not `inbox_version`.

PostgreSQL runs the existing payload query followed by the version query in one transaction.
This removes a second BEGIN, tenant-context assignment, agent lookup and COMMIT: four frontend
statements per paired read. Under READ COMMITTED these remain separate statement snapshots;
the version may include a message committed after the page query. Both statements use the same
resolved generation and expiry instant, so concurrent reopening or passage of wall-clock time
does not mix two generations or two expiry cutoffs in one response.
Sharing the fresh no-candidate expiry check also removes a separate BEGIN, tenant assignment and
COMMIT. With no named-session renewal, the complete paired operation uses seven protocol statements.

SQLite executes the pair synchronously in a transaction. Lifecycle pruning stays outside it
because that pruning uses an explicit BEGIN. Session renewal has no nested BEGIN, and the existing
page preflight transaction nests through Bun's savepoints.

The [8 MiB payload preflight](inbox-response-budget.md) and its validation remain unchanged.
Once materialized, a nonempty page remains charged while the version query and real handler are
unfinished, even if the HTTP response is canceled. It stays charged until both handler and
response finish. Version-query failure cannot turn an already settled reservation into an early
release. Empty and oversized pages retain their existing accounting behavior.

Standalone `getMessages` and `getInboxVersion` remain available. Long polling does not request an
unused version, and subscription/reconnect checks retain their independent authoritative read.
