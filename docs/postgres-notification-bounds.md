# PostgreSQL inbox notification bounds

The durable inbox remains authoritative. PostgreSQL notifications and reconnect catch-up only
tell a client to read it again. Delivery coalesces each subscribed tenant-and-agent inbox to its
latest sequence; duplicate and older hints add no queued work. Validated notifications for
inboxes without subscribers retain no state.

The dispatcher permits at most 16,384 occupied subscriptions per process, 1,024 per tenant, and
128 per inbox. The default HTTP allowance of 1,000 sessions globally and 100 per tenant, with ten
resource subscriptions per session, fits these limits. Long-poll inbox waits consume subscription
capacity too. Raising HTTP session limits can therefore encounter the independent dispatcher cap.
Overload uses the fixed error `Inbox subscription capacity reached`, without inbox identifiers.

Each subscriber can have one running handler. Other subscribers continue independently, including
subscribers belonging to another tenant. A five-second deadline fails initial subscription setup
or reports a background notification failure. Arbitrary handler code cannot be forcibly cancelled:
the occupied slot stays reserved until its underlying promise settles, including after unsubscribe.
Repeated notifications or unsubscribe/resubscribe attempts cannot allocate replacement work around
that bound. A late successful handler can resume delivery of the latest pending sequence if its
subscription is still active. A failed hint can be retried after a successful reconnect catch-up.

Reconnect notifications share one catch-up flag. A pass reads each distinct active inbox once,
independently of subscriber handlers. Only one durable lookup runs at a time; repeated reconnect
signals request at most one additional pass. A lookup exceeding fifteen seconds is reported, but
its occupied lookup remains until the underlying promise settles. Ordinary notification dispatch
continues meanwhile. Results belonging to an unsubscribed inbox cannot reach a replacement
subscription for that inbox. Database execution also has the separate
[runtime SQL deadlines](postgres-runtime-bounds.md).

Shutdown stops scheduling callbacks and cancels notification timers immediately. It does not wait
for arbitrary subscriber promises. Listener removal and database closure each receive a five-second
cleanup deadline; both cleanup steps run even if the first fails, and repeated close calls observe
the same result. A timed-out cleanup promise is observed for eventual rejection without creating
another retry loop.

Deterministic tests use an injected clock to cover exact deadlines, saturation, unresolved-handler
churn, cross-tenant progress, sequence coalescing, reconnect failures, late results, and shutdown.
