# Hosted materialization admission

Each hosted HTTP server shares a **32 MiB estimated materialization-byte budget** across all
sessions and tenants. This is separate from request-count, authentication, stream, and durable
storage budgets. It is not an exact RSS limit, a native socket-buffer bound, or a production
throughput guarantee.

Inbox, directory, notice and orchestration-policy page readers reserve their conservative 8 MiB
page ceiling immediately before querying payloads. The page query’s own byte gate runs before
payload materialization.
After the query and row validation finish, the reservation shrinks to the returned conservative
estimate. Empty pages release immediately; idle long-poll gaps therefore retain no page bytes.
Small completed pages consume their estimate, not a permanent 8 MiB slot. Four maximum-ceiling
queries fit simultaneously before any reservations shrink.

## Token lists and feedback results

`list_access_tokens` reserves 8 MiB in the common MCP tool before calling the control plane.
Its existing limit of 500, tenant qualification, tuple order and continuation cursor are unchanged;
no token is truncated or deleted. The retained estimate is 8 KiB for the tool envelope plus 8 KiB
per returned row, at most 4,104,192 bytes. The initial ceiling also accommodates the PostgreSQL
query's one lookahead row. An empty token list retains only its envelope allowance.

The row allowance covers the schema's two 200-character name/agent fields, 500-character ASCII
repository, 32-character ASCII key ID, UUIDs, role and four normalized timestamps, including the
structured result and its nested JSON tool text. Dates are normalized by `Instant.toISOString()`;
arbitrary timestamp precision is not copied into the response.

`submit_feedback` reserves 2 MiB after pure input/context validation, before reporter authorization
(which may read storage) or submission. The common tool covers SQLite and PostgreSQL and both
new submissions and idempotent replay; the returned description and original submission remain
unchanged. The retained estimate is 8 KiB plus 13 times the combined UTF-16 lengths of description,
title and branch. Their existing maxima of 100,000, 200 and 500 units yield 1,317,292 accounted
bytes. A code unit needs at most six bytes in structured JSON and seven in escaped tool text;
this includes controls and lone surrogates. The allowance covers the remaining bounded fields.

Both tools construct and validate their output while reserved. Invalid estimates fail before
serialization. Storage, authorization, validation and serialization failures release only after
the actual operation settles. Successful estimates stay charged through the handler/response
lifetime below. These are admission/accounting changes, not new content limits or backend writes.

Admission never waits or queues work. Exhaustion raises a fixed retryable MCP error with code
`-32003`, message `MCP error -32003: MCP materialization capacity reached; retry later.`, and data
`{"retryable":true,"retry_after_ms":1000}`. The SDK may already have opened HTTP 200 SSE; callers
must inspect the MCP result and use bounded retry/backoff. Numeric and string request IDs remain
unchanged. No request IDs are used as reservation keys.
Separate [request-ID admission](http-request-id-admission.md) prevents duplicate active IDs from
moving an SDK response onto another request's uncharged HTTP response.

## Lifetime and ownership

A request-local async context links each storage reservation to its actual MCP handler and HTTP
response. Nonempty page bytes remain charged until both the original handler settles and the
response stream finishes or is canceled. Canceling a request, sending `notifications/cancelled`,
or deleting its session cannot release an unfinished query. A pending query ticket remains
charged even if an outer promise has already settled. Tickets are released only by actual query
settlement or failure, never directly by an abort event.

The generic `reserveMaterializationBytes(ceiling)` hook returns:

- `settle(actualEstimate)`: shrink a successful page reservation; zero releases immediately.
- `fail()`: release a failed operation, only after the operation has actually settled.

Estimates must be nonnegative safe integers and cannot exceed their original ceiling. Repeated
cleanup is idempotent. The hook is inactive outside hosted request contexts, so stdio and direct
storage callers retain storage page limits without inheriting HTTP policy.

Broadcast commits use the distinct `reserveTemporaryMaterializationBytes(ceiling)` hook after
payload-free snapshot/generation validation and before fetching full payloads or allocating
sequences. Their scratch reservation is shared with page reservations but is released in the
batch-processing `finally`, after actual validation/insertion finishes. A small commit
acknowledgement does not retain its discarded working set through HTTP response completion.
Failure to acquire is immediate and the surrounding transaction rolls back; no memory wait
occurs while database locks are held.

## Limits of the estimate

The inbox byte estimator includes conservative JSON/encoding expansion and per-row overhead;
it is not merely raw message content length. [Directory metadata](agent-page-bounds.md) and
[notice pages](notice-page-bounds.md), [policy pages](orchestration-policy-pages.md) and
[encrypted broadcast payloads](e2ee-broadcast-memory.md) use separate estimates and the same hooks.
Ordinary small sends, acknowledgements, pings, and cancellation notifications do not acquire page
reservations.

`responseWithFinish` observes exhaustion/cancellation of the JavaScript response stream. Bun
may retain native buffers after consuming that stream; actual socket-drain behavior needs
separate slow-reader tests under the deployment memory limit. SDK SSE serialization also makes
complete event buffers. Do not present this estimated budget as proof that total process RSS
stays below 512 MiB.
