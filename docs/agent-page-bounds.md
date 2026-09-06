# Agent page bounds

`list_agents` returns at most the requested count and may return a shorter page to keep its
estimated serialized content within 8 MiB. Both stores select an ordered candidate page, calculate
its byte cost, and expose only the fitting prefix from that same SQL statement snapshot. Large
metadata never reaches the application for a candidate that does not fit. No agent is silently
skipped: `next_cursor` identifies the last returned agent, and the next request continues after it.

The estimate charges three times the UTF-8 size of stored metadata JSON plus 8 KiB per agent for
fixed fields, escaping, keys, and duplicated MCP text/structured content. PostgreSQL's JSONB text
representation can use more whitespace than SQLite's stored JSON, so the hosted security boundary
can produce a shorter page near the byte limit. Both adapters preserve ordering, filters, and
cursor semantics. A single stored agent that cannot fit fails with fixed owner-repair guidance;
the operation does not delete or truncate previously stored metadata.

Hosted reads reserve the 8 MiB ceiling before querying, then reduce it to the validated page
estimate. Empty pages release immediately. Nonempty results participate in the shared
[HTTP materialization budget](http-materialization-budget.md) until the handler and response finish.
This is an estimated content bound, not an exact process RSS or network-buffer limit.

MCP `resources/list` accepts `cursor` and returns `nextCursor` when more inboxes remain. The local
encrypted proxy preserves those cursors and checks subscription targets by `get_agent`, not by
assuming every agent appears in the first list page. Clients must drain all pages to enumerate
the full directory, even when their requested limit is 1,000.
