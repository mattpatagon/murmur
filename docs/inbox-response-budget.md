# Inbox response byte budget

Plaintext and encrypted inbox reads have an 8 MiB conservative response-byte budget in addition
to their existing message-count limit. It applies to current inbox reads, historical plaintext
reads, the reads performed by long polling, and the plaintext inbox resource.

The limit is inclusive. A page above the budget fails before its message payloads are returned
from storage. Successful pages retain the requested filters, ascending sequence order and count
limit; no message is silently omitted and no new output field is added.

The fixed caller-safe error is:

> Inbox page exceeds the response byte budget. Retry get_messages or get_encrypted_messages with a smaller limit (start with 1); inbox resource reads must use these tools instead.

Retry with a lower `limit`, starting with 1 if necessary. For an oversized resource read, use
`get_messages` instead. After consuming a page, continue with `after_sequence` equal to the last
returned message sequence (`tenant_sequence` on the encrypted wire API). The inbox's
`inbox_version` is a notification high-water mark, not a pagination cursor; advancing directly
to it can skip messages. Reading still does not mark messages as read.

## Accounting

The estimate deliberately includes MCP's JSON text plus structured-content representations and
escaping rather than treating stored content bytes as response bytes:

| Page kind | Per-row estimate |
| --- | --- |
| Plaintext | 13 × UTF-8 content bytes + 16 KiB |
| Encrypted | 3 × UTF-8 stored envelope and sender-chain JSON bytes + 16 KiB |

A plaintext control byte such as U+0001 becomes six bytes in JSON, seven inside the tool's
JSON text string, and six in its structured-content copy. The multiplier 13 covers that worst
case. The fixed allowance covers bounded non-content fields and formatting. Encrypted stored
JSON already escapes controls; the factor 3 covers the additional escaping and duplicate
representation. These conservative estimates can reject a page whose actual response is smaller.

All currently valid single PostgreSQL rows fit: plaintext content is at most 100,000 UTF-16 code
units at the application boundary; each encrypted envelope and sender-chain JSON column is
independently limited to 1 MiB. The largest encrypted single-row estimate is 6 MiB + 16 KiB.
SQLite has no equivalent historical JSON-column size check. An unusually large legacy SQLite
encrypted row can therefore exceed the budget even at `limit: 1` and fails explicitly; this
change neither truncates nor deletes that row nor changes timestamp or write protocols.

PostgreSQL measures its stored `jsonb::text` representation, including its formatting spaces;
SQLite measures its stored JSON text. This narrow accounting difference can make an encrypted
page near the threshold fail on one backend but pass on the other. Returned content, ordering,
filtering and pagination semantics are unchanged. Plaintext accounting is identical.

## Snapshot and memory guarantees

PostgreSQL selects at most the requested number of candidate sequences and numeric byte costs
in a materialized common-table expression. The aggregate budget gates the payload join in the
same SQL statement. An oversized page returns only a small accounting sentinel, not ciphertext
or message content. The tenant-qualified join cannot substitute another tenant's row.

SQLite computes candidate byte costs first, then reads their payloads in the same synchronous
read transaction. A concurrent writer cannot change the payload snapshot after admission.

Hosted reads reserve the 8 MiB ceiling from the shared materialization budget before these SQL
operations, shrink it to their validated estimate on success, and immediately release zero-byte
pages and completed failures. Nonempty reservations remain until both actual handler processing
and the HTTP response complete. Empty long-poll waits do not retain a page reservation between
reads. Local callers retain the page cap without requiring an HTTP context.
See the [shared HTTP materialization budget](http-materialization-budget.md) for capacity,
request cancellation, and response-lifetime behavior.

This is a response estimate, not an RSS measurement or a guarantee that the entire process uses
less than 512 MiB. Runtime overhead and temporary JSON/string/encoded-buffer copies still exist;
the shared hosted byte budget and response-lifetime admission separately bound concurrent pages.
