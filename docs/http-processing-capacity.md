# HTTP response and MCP processing capacity

Hosted HTTP has two independent budgets, both configured by
`MURMUR_MAX_ACTIVE_REQUESTS`, `MURMUR_MAX_ACTIVE_REQUESTS_PER_PRINCIPAL`, and
`MURMUR_MAX_ACTIVE_REQUESTS_PER_TENANT`:

- Response admission bounds active non-GET HTTP requests until their response finishes or the
  client disconnects. Exhaustion returns HTTP 503, as before.
- Processing admission bounds unfinished MCP request handlers across every session on
  the server. A client disconnect, MCP cancellation notification, or session close does not
  release processing capacity while the original handler is still running.

Processing exhaustion rejects before invoking a request handler. The transport may already have
opened an HTTP 200 SSE response; its JSON-RPC error has code **-32003**, a fixed message
`MCP error -32003: MCP processing capacity reached; retry later.`, and data
`{"retryable":true,"retry_after_ms":1000}`. Clients should use bounded backoff of at least one
second and retain rejected-operation counts; an HTTP 200 alone does not indicate MCP success.
The original JSON-RPC ID remains unchanged, including numeric IDs.

The global processing controller is shared across hosted sessions. The generic registration
wrapper covers tools, resources, SDK initialization and ping, including later registrations. It
awaits each original handler promise and releases its reservation exactly once in `finally`,
including error paths. It does not race cancellation against that promise or claim to interrupt
an already-issued database statement. Queued resource mutations may settle immediately when
canceled before execution; active mutations retain their charge until their actual work ends.

Notifications do not acquire processing capacity; initialization and ping do. All still pass
normal HTTP authentication, request admission, and rate limits. Once a canceled response releases
its response slot, an authenticated cancellation notification can reach the
SDK even while all processing slots remain occupied. A DELETE can close a session without
creating another opportunity to exceed the shared processing budget.

The non-HTTP/stdio application path has no HTTP processing reservation callback. This does not
change its existing local resource limits. Custom hosted application factories must forward
the supplied `reserveProcessingCapacity` callback, as the default factory does.

Session construction reuses validated JSON Schema snapshots keyed only by the fixed application
schema objects. Weak keys cannot retain discarded schema objects, and no tenant, credential,
request, or authorization result is cached. Each catalog receives fresh, deeply cloned schema
metadata and annotations. Principal and encryption-entitlement filtering still runs for each
application; runtime input, output, and database-row validation is unchanged.

Tests use deterministic blocked fake stores and actual localhost HTTP/SDK round trips for all
three configured budgets, initialization, reads, tools, subscription cancellation, session close,
cross-session rejection, numeric/string IDs, handler failure, and recovery after settlement. They do not
establish production throughput, database cancellation, or a maximum duration for blocked work.

See [resource mutation bounds](mcp-resource-mutation-bounds.md) for the separate per-session queue
and [rate-window bounds](http-rate-window-bounds.md) for bounded rate-limit bookkeeping.
