# Notice page byte bounds

`list_notices` returns the largest ordered prefix that fits both its requested count limit and
an inclusive 8 MiB conservative response estimate. A successful page may contain fewer notices
than `limit` even when more notices remain. Each returned notice is complete; no content or
resolution note is truncated or deleted.

Continue with the returned `next_cursor` until it is `null`. The existing ordering remains
`created_at DESC, notice_id ASC`; a non-null cursor identifies the last returned notice, not
the first excluded notice. Repository, branch, kind, state, actor and session behavior are
unchanged. No MCP input or output fields were added.

Each row is charged `13 × (UTF-8 content bytes + UTF-8 resolution-note bytes) + 16 KiB`.
The multiplier covers JSON escaping plus the tool text and structured-content copies; the
fixed allowance covers bounded identifiers, branch/repository fields, timestamps and framing.
Control characters therefore consume more budget than their raw stored byte count suggests.
All currently valid single notices fit. An oversized legacy row that cannot fit by itself
fails with the fixed safe error:

> Stored notice exceeds the safe page size; contact the service owner.

PostgreSQL materializes only candidate IDs, timestamps and numeric costs, with at most
`limit + 1` candidates. Ordered window sums determine the fitting prefix before an explicitly
tenant-qualified payload join. Rejected suffix rows carry no payload. Selection and payload
reads use the same SQL statement snapshot through the existing least-privilege runtime role
and tenant transaction context. No RLS policy, grant or migration changes are needed.

SQLite reads the same candidate costs and the fitting payload prefix inside one synchronous
read transaction. Concurrent updates cannot replace admitted rows between those reads.
Both backends account for UTF-8 bytes identically, preserve the same cursor semantics, and
do not fetch a full-content lookahead row merely to determine whether another page exists.

Hosted reads reserve the 8 MiB ceiling before page selection, then shrink to the validated
actual estimate. Empty results and settled query failures release immediately; nonempty results
remain charged until both handler processing and the HTTP response finish. Cancellation does
not release an unfinished query. See the [shared HTTP materialization budget](http-materialization-budget.md).

This bounds notice response materialization, not total process RSS. It makes no independent
claim that a 512 MiB deployment passes its combined load and native-response verification gates.
