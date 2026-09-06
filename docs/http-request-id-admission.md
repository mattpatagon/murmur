# HTTP request-ID admission

Hosted MCP HTTP requests claim their JSON-RPC ID before entering the SDK transport. A claim is
scoped to the MCP session and preserves the ID's type: numeric `42` and string `"42"` are distinct.
An ID can be reused after its previous request completes. Clients must not reuse an active ID.
Cancellation before a response send can retire the session, as described below.

Each HTTP server admits at most **256 active IDs**, with at most **64 per session**. String request
IDs are limited to **1,024 UTF-16 code units**; numbers retain SDK validation. Tracking has no
completed-ID history or waiting queue. HTTP requests must contain exactly one JSON-RPC message.
All arrays, including empty, notification-only and response-only arrays, are rejected before SDK
dispatch. Parallel single-message POSTs remain supported. Existing message fields and ID values
are not rewritten.

Admission errors are immediate HTTP responses with JSON-RPC `id: null`; rejected IDs are never
reflected:

| HTTP status | MCP code | Fixed message |
| --- | --- | --- |
| 409 | -32600 | `MCP request ID is already active.` |
| 400 | -32600 | `MCP request ID exceeds 1024 UTF-16 units.` |
| 400 | -32600 | `MCP request parameters are invalid or unsupported.` |
| 400 | -32600 | `MCP HTTP requests must contain one JSON-RPC message; batches are not supported.` |
| 503 | -32003 | `MCP request-ID admission capacity reached; retry later.` |

The capacity error also includes `Retry-After: 1` and
`{"retryable":true,"retry_after_ms":1000}`. Callers should use bounded backoff. These limits are
independent of processing-count and [materialization-byte admission](http-materialization-budget.md).
At the string-ID maximum, even an ID consisting entirely of JSON-escaped control characters fits
within the existing 8 KiB fixed response-envelope allowance.

## Claim lifetime

A claim remains active until the original HTTP response finishes or is canceled, the actual
request handler settles, and the SDK's response `send` settles. Canceling a response alone does
not release a queued or running handler. A completed handler and send do not release an unread
response. A failed send releases its ownership only after the send promise actually settles.

The only no-send shortcut is the actual handler's monotonic SDK `extra.signal.aborted`, observed
before any send begins. The send wrapper marks send-start synchronously before awaiting the
transport. An abort after that point cannot release a pending send. Requests rejected by the
transport before dispatch have no handler/send owners to await.

When the no-send shortcut applies and both the actual handler and original HTTP response have
finished, Murmur retires that affected MCP session through the public transport close API. Its
ephemeral subscriptions are closed and clients must initialize a new session before further work.
Other sessions and durable data are unchanged. Normal completion, duplicate-ID rejection and an
abort after send-start do not trigger retirement. The HTTP router normally returns its existing
session-not-found 404 for the old session; direct admission fallback returns 404 with
`MCP session ended after cancellation; initialize a new session.` and `id: null`.

This prevents the SDK's skipped-response correlation entries from accumulating indefinitely in a
live session. Retirement does not release another unfinished handler's processing or byte owners;
those still await actual settlement.

The server lazily wraps every public request-handler registration, including the SDK constructor's
`initialize` and `ping` handlers. Public transport callbacks associate actual handlers and response
sends with the original claim. Server-initiated requests, client responses and notifications do
not acquire or finish incoming request-ID claims. Session GET/DELETE behavior is unchanged.

The original registered request schemas and task capabilities are checked before SDK dispatch.
Invalid method parameters and unsupported task requests now receive the fixed HTTP 400 above,
without creating claims. This matters because the SDK performs those checks before invoking the
handler wrapper: cancellation can suppress the resulting error send before the wrapper receives
the SDK abort signal. Preflight keeps that path out of tracking. Normal SDK validation and tool
result validation remain enabled; unknown-method responses keep their existing SDK behavior.

This closes an SDK routing hazard: without admission, a second in-flight request can replace the
first ID's stream mapping. The first response can then be sent to the second HTTP response after
the first request's byte-accounting lifetime has ended. The regression uses the real SDK transport,
deferred handlers and only 256 counted bytes; it requires no database or large allocation.

A second regression verifies the pinned SDK's batch-retention hazard: after one result completes
and a sibling is canceled before sending, canceling the HTTP body does not clear the completed
result retained by the SDK. Its byte owners can already have finished. Rejecting batches avoids
this retained-result path without inspecting or modifying private SDK state in production. The
diagnostic test reads the pinned SDK's map only to establish the failure mode.

## Scope and maintenance

The implementation uses public SDK APIs and request-local async context, not private SDK fields,
timers, guessed cleanup delays, or ID rewriting. Murmur does not configure SDK task stores or task
message queues. Its pinned SDK checks the abort signal immediately before a response send with no
intervening asynchronous task-queue operation; SDK upgrades or enabling task queues require a
fresh lifecycle review and the real-transport regression suite.

SDK 1.30.0 negotiates `2025-11-25` by default and also supports older protocol versions. Its server
transport and typed client `send` API still accept arrays. Batch rejection is an intentional hosted
restriction, including for older negotiated versions; clients sending batches must send individual
messages instead. Stdio behavior is unchanged.

Claims bound correlation state; they are not a physical-memory or throughput guarantee. Native
HTTP buffering and the process/cgroup memory limit still require separate deployment verification.
