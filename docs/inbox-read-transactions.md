# Paired inbox reads

`get_messages`, `get_message_history`, and plaintext inbox resource reads use the internal
`MessageStore.getMessagesWithVersion` result. No MCP input, output field, count limit,
pagination behavior, or error shape changes. Successful current-generation `get_messages` pages
are now acknowledgement receipts: every returned message has a non-null `read_at`. Historical and
resource reads remain non-consuming.

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
For a current tool read, PostgreSQL updates only unread returned message IDs before committing that
same tenant transaction. Already acknowledged rows retain their selected receipt without another
write. `COALESCE` preserves a concurrently committed receipt, `RETURNING` supplies each actual
stored timestamp, and a missing or malformed acknowledgement row fails and rolls back the response.
The fresh no-candidate expiry check retains its own BEGIN, tenant assignment and COMMIT, so it
releases the connection before the operation rejoins the pool queue. With no named-session renewal,
history and resource reads use nine protocol statements, including the separate preflight; a
current `get_messages` page uses at most ten because an all-acknowledged page skips the update.

SQLite executes a current tool read in an immediate transaction so concurrent readers cannot both
upgrade a deferred read transaction while acknowledging the same page. Page selection, the
independent version, named-session renewal, and acknowledgement either commit together or roll back
together. Lifecycle pruning stays outside because it uses an explicit BEGIN. Historical and
resource reads keep their non-mutating transaction behavior, and the page preflight transaction
nests through Bun's savepoints.

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
unused version; a nonempty `wait_for_messages` result acknowledges its returned page in the same
way as `get_messages`. Subscription/reconnect checks retain their independent authoritative read.

The encrypted proxy cannot acknowledge hosted ciphertext before trusting it. It verifies and
decrypts the complete returned page locally, then uses the dedicated bounded
`acknowledge_encrypted_messages` wire operation and returns its authoritative per-message
`read_at` receipts rather than the acknowledgement request time. This additive operation leaves
the existing `mark_messages_read` wire response unchanged while keeping concurrent readers
consistent with the first committed receipt. Any verification,
decryption, or acknowledgement failure rejects the call; verification and decryption failures
happen before any acknowledgement, while a lost remote acknowledgement response has the usual
indeterminate network outcome. Automatic acknowledgement
retains the local decrypted replay cache because one-time prekeys have already been consumed; the
explicit `mark_messages_read` compatibility operation remains available when deliberate cache
removal is required. The owner-only vault
purges cache rows at envelope expiry. Its reachable cache
is bounded by the server's 100,000-message and 256 MiB retained-ciphertext tenant quotas, and each
cached plaintext is independently limited to 100,000 characters.
